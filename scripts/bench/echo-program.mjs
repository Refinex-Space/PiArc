// The program the S7 echo measurement types into on Windows (s7-terminal.mjs): reads its
// raw-mode stdin and writes every byte straight back, a carriage return as CR LF. In ConPTY the
// line echo of a cooked console is conhost's, and cmd.exe would run each line, so the
// measurement uses this instead of `cat`. Both halves of a sample (Core's direct probe and the
// typed key) go through the same program, so their difference stays the client path's cost.
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  process.stdout.write(
    data.includes(0x0d)
      ? Buffer.from(data.toString('latin1').replaceAll('\r', '\r\n'), 'latin1')
      : data,
  );
});
