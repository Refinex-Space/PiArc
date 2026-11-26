//! The TCP ports process trees listen on (ADR-0092 rule 5, design addendum
//! `docs/architecture/addenda/browser.md` B2.6.2 and B4.4): which ports the processes a
//! background task, a terminal or a development server started have open for connections.
//!
//! A tree is its root process and the processes known to belong to it ([`Tree`]); a
//! listening socket belongs to the tree when its process is a member, is the root, is in the
//! root's process group (Unix: what [`crate::ProcessTreeSpawner`] starts leads its own group),
//! or descends from the root by parent links (Windows, where a Job Object holds the tree).
//!
//! - **macOS**: `lsof -nP -w -iTCP -sTCP:LISTEN -FpgRn` lists the user's listening sockets
//!   with their process, process group and parent; it is stopped after [`LSOF_TIMEOUT`].
//! - **Windows**: `GetExtendedTcpTable` for IPv4 and IPv6 listeners with their owning
//!   process (`tcp_table`, the safe wrapper), and a ToolHelp snapshot for the parent links.
//!
//! Only this user's processes are visible, which is what the question is about: a session's
//! processes run as the user.

use std::collections::{BTreeSet, HashMap};

/// How long `lsof` may take before it is stopped (macOS).
pub const LSOF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// One process tree to ask about.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tree {
    /// The process the tree started from: a command's shell (the leader of its process group
    /// on Unix), a terminal's shell.
    pub root: u32,
    /// Processes known to be in the tree besides the root (a terminal's processes on macOS).
    pub members: Vec<u32>,
}

/// A listening TCP socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Socket {
    pub port: u16,
    pub pid: u32,
    /// The process group (Unix).
    pub group: Option<u32>,
}

/// The listening sockets and the parent links the matching needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Table {
    pub sockets: Vec<Socket>,
    /// Process → parent.
    pub parents: HashMap<u32, u32>,
}

/// The ports each of `trees` listens on, in order, each list sorted.
///
/// # Errors
///
/// [`crate::Error::Listeners`]: the sockets cannot be listed (no `lsof`, it failed or took
/// too long; the system call failed).
pub fn listening(trees: &[Tree]) -> crate::Result<Vec<Vec<u16>>> {
    if trees.is_empty() {
        return Ok(Vec::new());
    }
    let table = platform::table().map_err(|source| crate::Error::Listeners { source })?;
    Ok(trees.iter().map(|tree| ports_of(&table, tree)).collect())
}

/// The ports of `tree` in `table`.
#[must_use]
pub fn ports_of(table: &Table, tree: &Tree) -> Vec<u16> {
    let ports: BTreeSet<u16> = table
        .sockets
        .iter()
        .filter(|socket| belongs(table, tree, socket))
        .map(|socket| socket.port)
        .collect();
    ports.into_iter().collect()
}

fn belongs(table: &Table, tree: &Tree, socket: &Socket) -> bool {
    if socket.pid == tree.root || tree.members.contains(&socket.pid) {
        return true;
    }
    if tree.root != 0 && socket.group == Some(tree.root) {
        return true;
    }
    // Up the parent links, a bounded number of steps (pids can be reused into loops).
    let mut pid = socket.pid;
    for _ in 0..64 {
        match table.parents.get(&pid) {
            Some(&parent) if parent == tree.root && parent != 0 => return true,
            Some(&parent) if parent != 0 && parent != pid => pid = parent,
            _ => return false,
        }
    }
    false
}

/// Parses `lsof -F pgRn` output: `p<pid>`, `g<pgid>`, `R<ppid>` start and describe a process,
/// `n<address>:<port>` names one of its sockets; other fields are skipped.
#[must_use]
pub fn parse_lsof(output: &str) -> Table {
    let mut table = Table::default();
    let mut pid: Option<u32> = None;
    let mut group: Option<u32> = None;
    for line in output.lines() {
        let (field, value) = line.split_at(line.len().min(1));
        match field {
            "p" => {
                pid = value.parse().ok();
                group = None;
            }
            "g" => group = value.parse().ok(),
            "R" => {
                if let (Some(pid), Ok(parent)) = (pid, value.parse()) {
                    table.parents.insert(pid, parent);
                }
            }
            "n" => {
                let (Some(pid), Some(port)) = (pid, socket_port(value)) else {
                    continue;
                };
                let socket = Socket { port, pid, group };
                if !table.sockets.contains(&socket) {
                    table.sockets.push(socket);
                }
            }
            _ => {}
        }
    }
    table
}

/// The local port of an `lsof` socket name (`*:3000`, `127.0.0.1:5173`, `[::1]:8080`); none
/// for a connection (`a->b`).
fn socket_port(name: &str) -> Option<u16> {
    if name.contains("->") {
        return None;
    }
    name.rsplit_once(':')
        .and_then(|(_, port)| port.trim().parse().ok())
        .filter(|port| *port > 0)
}

/// Bytes of one row of `MIB_TCPTABLE_OWNER_PID` and where its port and pid are.
const V4_ROW: (usize, usize, usize) = (24, 8, 20);
/// Bytes of one row of `MIB_TCP6TABLE_OWNER_PID` and where its port and pid are.
const V6_ROW: (usize, usize, usize) = (56, 20, 52);

/// Parses the buffer `GetExtendedTcpTable` filled for IPv4 (`v6` false) or IPv6: a `u32`
/// count, then the rows. A port is in network byte order in the low 16 bits of its field.
#[must_use]
pub fn parse_tcp_table(buffer: &[u8], v6: bool) -> Vec<Socket> {
    let (row, port_at, pid_at) = if v6 { V6_ROW } else { V4_ROW };
    let word = |at: usize| -> Option<u32> {
        buffer
            .get(at..at + 4)
            .and_then(|b| <[u8; 4]>::try_from(b).ok())
            .map(u32::from_ne_bytes)
    };
    let Some(count) = word(0) else {
        return Vec::new();
    };
    let mut sockets = Vec::new();
    for index in 0..usize::try_from(count).unwrap_or(0) {
        let start = 4 + index * row;
        let (Some(port), Some(pid)) = (word(start + port_at), word(start + pid_at)) else {
            break;
        };
        let raw = port.to_ne_bytes();
        // The two bytes of the 16-bit field come first in memory, in network order.
        let port = u16::from_be_bytes([raw[0], raw[1]]);
        if port > 0 {
            sockets.push(Socket {
                port,
                pid,
                group: None,
            });
        }
    }
    sockets
}

#[cfg(unix)]
mod platform {
    use std::io::{self, Read};
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    use super::{LSOF_TIMEOUT, Table, parse_lsof};

    const LSOF: [&str; 2] = ["/usr/sbin/lsof", "/usr/bin/lsof"];

    pub(super) fn table() -> io::Result<Table> {
        let program = LSOF
            .iter()
            .map(Path::new)
            .find(|path| path.exists())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "lsof is not installed"))?;
        let mut child = Command::new(program)
            .args(["-nP", "-w", "-iTCP", "-sTCP:LISTEN", "-FpgRn"])
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let pid = child.id();
        let done = Arc::new(AtomicBool::new(false));
        let watchdog = {
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                let deadline = Instant::now() + LSOF_TIMEOUT;
                while !done.load(Ordering::SeqCst) {
                    if Instant::now() >= deadline {
                        if let Ok(pid) = i32::try_from(pid) {
                            let _ = nix::sys::signal::kill(
                                nix::unistd::Pid::from_raw(pid),
                                nix::sys::signal::Signal::SIGKILL,
                            );
                        }
                        return true;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                false
            })
        };
        let mut output = String::new();
        let read = child
            .stdout
            .take()
            .map_or(Ok(0), |mut out| out.read_to_string(&mut output));
        let status = child.wait();
        done.store(true, Ordering::SeqCst);
        let killed = watchdog.join().unwrap_or(false);
        if killed {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "lsof took too long",
            ));
        }
        read?;
        let status = status?;
        // lsof exits 1 when nothing matched.
        if !status.success() && !(status.code() == Some(1) && output.trim().is_empty()) {
            return Err(io::Error::other(format!("lsof failed: {status}")));
        }
        Ok(parse_lsof(&output))
    }
}

#[cfg(windows)]
mod platform {
    use std::io;

    use super::{Table, parse_tcp_table};

    pub(super) fn table() -> io::Result<Table> {
        let mut sockets = parse_tcp_table(&crate::tcp_table::listeners(false)?, false);
        for socket in parse_tcp_table(&crate::tcp_table::listeners(true)?, true) {
            if !sockets.contains(&socket) {
                sockets.push(socket);
            }
        }
        let parents = crate::job::process_table()?
            .into_iter()
            .map(|entry| (entry.pid, entry.parent))
            .collect();
        Ok(Table { sockets, parents })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_output_names_ports_processes_and_groups() {
        let output = "p100\ng100\nR1\nf5\nn*:3000\nf6\nn[::1]:3000\np200\ng100\nR100\nf7\nn127.0.0.1:5173\np300\ng300\nR1\nf3\nn10.0.0.2:22->10.0.0.9:5000\nf4\nn*:0\n";
        let table = parse_lsof(output);
        assert_eq!(
            table.sockets,
            [
                Socket {
                    port: 3000,
                    pid: 100,
                    group: Some(100)
                },
                Socket {
                    port: 5173,
                    pid: 200,
                    group: Some(100)
                },
            ]
        );
        assert_eq!(table.parents.get(&200), Some(&100));
        assert_eq!(
            ports_of(
                &table,
                &Tree {
                    root: 100,
                    members: vec![]
                }
            ),
            [3000, 5173]
        );
        assert!(
            ports_of(
                &table,
                &Tree {
                    root: 300,
                    members: vec![]
                }
            )
            .is_empty()
        );
        assert_eq!(
            ports_of(
                &table,
                &Tree {
                    root: 9,
                    members: vec![200]
                }
            ),
            [5173]
        );
    }

    #[test]
    fn descendants_belong_through_parent_links() {
        let table = Table {
            sockets: vec![
                Socket {
                    port: 8080,
                    pid: 30,
                    group: None,
                },
                Socket {
                    port: 9229,
                    pid: 40,
                    group: None,
                },
            ],
            parents: HashMap::from([(30, 20), (20, 10), (40, 4), (4, 4)]),
        };
        assert_eq!(
            ports_of(
                &table,
                &Tree {
                    root: 10,
                    members: vec![]
                }
            ),
            [8080]
        );
        assert!(
            ports_of(
                &table,
                &Tree {
                    root: 0,
                    members: vec![]
                }
            )
            .is_empty()
        );
    }

    fn row(buffer: &mut Vec<u8>, size: usize, port_at: usize, pid_at: usize, port: u16, pid: u32) {
        let start = buffer.len();
        buffer.resize(start + size, 0);
        let be = port.to_be_bytes();
        buffer[start + port_at] = be[0];
        buffer[start + port_at + 1] = be[1];
        buffer[start + pid_at..start + pid_at + 4].copy_from_slice(&pid.to_ne_bytes());
    }

    #[test]
    fn tcp_tables_of_both_families_parse() {
        let mut v4 = 2u32.to_ne_bytes().to_vec();
        row(&mut v4, 24, 8, 20, 3000, 77);
        row(&mut v4, 24, 8, 20, 445, 4);
        assert_eq!(
            parse_tcp_table(&v4, false),
            [
                Socket {
                    port: 3000,
                    pid: 77,
                    group: None
                },
                Socket {
                    port: 445,
                    pid: 4,
                    group: None
                },
            ]
        );
        let mut v6 = 1u32.to_ne_bytes().to_vec();
        row(&mut v6, 56, 20, 52, 5173, 88);
        assert_eq!(
            parse_tcp_table(&v6, true),
            [Socket {
                port: 5173,
                pid: 88,
                group: None
            }]
        );
        // A short buffer stops at the last whole row.
        assert_eq!(parse_tcp_table(&v4[..30], false).len(), 1);
        assert!(parse_tcp_table(&[], true).is_empty());
    }

    #[test]
    fn finds_a_port_this_process_listens_on() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("address").port();
        let me = Tree {
            root: std::process::id(),
            members: Vec::new(),
        };
        let found = listening(&[me, Tree::default()]).expect("listing");
        assert!(found[0].contains(&port), "{port} not in {:?}", found[0]);
        assert!(!found[1].contains(&port));
    }
}
