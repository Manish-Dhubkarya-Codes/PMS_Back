const { execSync } = require("child_process");

const port = String(process.argv[2] || 3000);

function pidsOnPort(p) {
  try {
    const out = execSync(`netstat -ano`, { encoding: "utf8" });
    const ids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${p}`) || !/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid > 0) ids.add(pid);
    }
    return [...ids];
  } catch {
    return [];
  }
}

const pids = pidsOnPort(port);
if (!pids.length) {
  console.log(`✅ Port ${port} is free`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    console.log(`✅ Freed port ${port} (killed PID ${pid})`);
  } catch (err) {
    console.error(`❌ Could not kill PID ${pid} on port ${port}`);
    console.error(err.message);
    process.exit(1);
  }
}
