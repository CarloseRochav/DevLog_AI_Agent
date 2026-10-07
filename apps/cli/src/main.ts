import { runCli } from "./index.js";

const code = await runCli(process.argv, {
  env: process.env,
  io: {
    log: (message) => {
      console.log(message);
    },
    error: (message) => {
      console.error(message);
    },
  },
});

process.exit(code);
