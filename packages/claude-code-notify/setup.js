const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

if (process.platform !== "win32") {
  console.error("claude-code-notify setup currently only supports Windows.");
  process.exit(1);
}

const home = os.homedir();
const targetDir = path.join(home, ".claude", "scripts", "claude-notify");
const settingsPath = path.join(home, ".claude", "settings.json");

console.log("");
console.log("=== Claude Code Notification Setup ===");
console.log("");

// Step 1: Copy scripts
console.log("[1/4] Copying scripts...");
fs.mkdirSync(targetDir, { recursive: true });

const scriptsDir = path.join(__dirname, "scripts");
const filesToCopy = [
  "notify.ps1",
  "activate-window.ps1",
  "activate-window-silent.vbs",
  "register-protocol.ps1",
];

for (const file of filesToCopy) {
  const src = path.join(scriptsDir, file);
  const dst = path.join(targetDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`      Copied ${file}`);
  }
}
console.log("      Done");

// Step 2: Install BurntToast
console.log("[2/4] Checking BurntToast module...");
const checkBT = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    "if (Get-Module -ListAvailable BurntToast) { 'installed' } else { 'missing' }",
  ],
  { encoding: "utf-8" }
);

if (checkBT.stdout.trim() === "missing") {
  console.log("      Installing BurntToast...");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Install-Module -Name BurntToast -Scope CurrentUser -Force",
    ],
    { stdio: "inherit" }
  );
  console.log("      Done");
} else {
  console.log("      Already installed");
}

// Step 3: Register protocol handler
console.log("[3/4] Registering protocol handler...");
const registerScript = path.join(targetDir, "register-protocol.ps1");
spawnSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registerScript],
  { stdio: "inherit" }
);
console.log("      Done");

// Step 4: Configure hooks in settings.json
console.log("[4/4] Configuring hooks...");

const hookCommand =
  "cmd /c npx -y claude-code-notify@latest";

const hookEntry = {
  hooks: [
    {
      type: "command",
      command: hookCommand,
      async: true,
    },
  ],
};

const claudeDir = path.join(home, ".claude");
fs.mkdirSync(claudeDir, { recursive: true });

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    console.log("      Warning: Could not parse existing settings.json, creating new one");
  }
}

if (!settings.hooks) {
  settings.hooks = {};
}

let modified = false;

if (!settings.hooks.Stop) {
  settings.hooks.Stop = [hookEntry];
  modified = true;
} else {
  console.log("      Stop hook already exists, skipping");
}

if (!settings.hooks.PermissionRequest) {
  settings.hooks.PermissionRequest = [hookEntry];
  modified = true;
} else {
  console.log("      PermissionRequest hook already exists, skipping");
}

if (modified) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), "utf-8");
  console.log("      Done");
} else {
  console.log("      Hooks already configured");
}

console.log("");
console.log("=== Setup Complete ===");
console.log("");
console.log("Restart Claude Code to activate notifications.");
console.log("");
