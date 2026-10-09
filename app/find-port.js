const net = require("node:net");

function isPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", error => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(error => error ? reject(error) : resolve(true));
    });
  });
}

async function main() {
  for (let port = 3001; port <= 3010; port += 1) {
    if (await isPortAvailable(port)) {
      console.log(port);
      return;
    }
  }
  throw new Error("Нет свободного порта в диапазоне 3001–3010.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
