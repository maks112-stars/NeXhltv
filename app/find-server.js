async function findNexhltvServer() {
  for (let port = 3001; port <= 3010; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/data`, {
        signal: AbortSignal.timeout(500)
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (!["players", "teams", "matches", "leagues"].every(key => Array.isArray(data[key]))) continue;
      const adminResponse = await fetch(`http://127.0.0.1:${port}/api/admin/session`, {
        signal: AbortSignal.timeout(500)
      });
      if (adminResponse.status !== 200) continue;
      const session = await adminResponse.json();
      if (typeof session.authenticated !== "boolean" || session.instance !== "nexhltv") continue;
      console.log(port);
      return true;
    } catch {
      // No Nexhltv server is listening on this port.
    }
  }
  return false;
}

findNexhltvServer().then(found => {
  if (!found) process.exitCode = 1;
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
