// A stub server for the environment-filter test: it speaks no JSON-RPC at all, it
// writes the environment it was started with to the file named by its FIRST
// ARGUMENT and exits. The path arrives as an argument rather than as a variable
// because what is under test is exactly which variables survive — a stub told where
// to write through the environment could not tell a dropped variable from a broken
// stub.
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], JSON.stringify(process.env));
