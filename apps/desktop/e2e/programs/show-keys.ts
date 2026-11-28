// A terminal program for the L4 key test on Windows (terminal.e2e.ts), run by Node directly
// (type stripping): turns on application cursor keys (DECCKM), then prints each read of its
// raw-mode stdin with control characters as `^X`. `q` ends it.
process.stdout.write('\u001b[?1hready\r\n');
process.stdin.setRawMode(true);
process.stdin.on('data', (data: Buffer) => {
  const shown = [...data]
    .map((byte) =>
      byte < 0x20 ? `^${String.fromCharCode(byte + 0x40)}` : String.fromCharCode(byte),
    )
    .join('');
  process.stdout.write(`got ${shown}\r\n`);
  if (shown.includes('q')) {
    process.exit(0);
  }
});
