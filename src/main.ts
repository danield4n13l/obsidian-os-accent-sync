import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

interface OsAccentPluginSettings {
  autoSync: boolean;
  pollIntervalSec: number;
}

const DEFAULT_SETTINGS: OsAccentPluginSettings = {
  autoSync: true,
  pollIntervalSec: 10
};

export default class OsAccentColorPlugin extends Plugin {
  settings: OsAccentPluginSettings;
  private checkIntervalId: number | null = null;
  private lastAppliedColor: string | null = null;
  private focusHandler: () => void;
  private mediaQueryList: MediaQueryList | null = null;
  private mediaQueryHandler: () => void;

  async onload() {
    await this.loadSettings();

    // 1. Initial color synchronization
    await this.syncAccentColor();

    // 2. Setup change listeners
    this.registerChangeListeners();

    // 3. Settings tab
    this.addSettingTab(new OsAccentSettingTab(this.app, this));

    // 4. Command for manual execution
    this.addCommand({
      id: "sync-os-accent-color",
      name: "Sync accent color with OS now",
      callback: async () => {
        await this.syncAccentColor(true);
      }
    });
  }

  onunload() {
    this.stopPolling();

    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
    }

    if (this.mediaQueryList && this.mediaQueryHandler) {
      this.mediaQueryList.removeEventListener("change", this.mediaQueryHandler);
    }
  }

  /**
   * Fetches the current OS accent color and updates Obsidian if it changed.
   */
  async syncAccentColor(force = false): Promise<void> {
    const hexColor = await this.getSystemAccentColor();
    if (!hexColor) return;

    if (force || hexColor.toLowerCase() !== this.lastAppliedColor?.toLowerCase()) {
      this.applyAccentColor(hexColor);
      this.lastAppliedColor = hexColor;
    }
  }

  /**
   * Platform-specific color resolution.
   */
  private async getSystemAccentColor(): Promise<string | null> {
    const platform = process.platform;

    if (platform === "win32") {
      const winColor = await this.getWindowsAccentColor();
      if (winColor) return winColor;
    } else if (platform === "darwin") {
      const macColor = await this.getMacAccentColor();
      if (macColor) return macColor;
    }

    // Fallback: Chromium CSS System Colors
    return this.getCssSystemAccentColor();
  }

  /**
   * Windows: Queries the Desktop Window Manager (DWM) registry entry.
   * DWM AccentColor is stored as a DWORD in 0xAABBGGRR format.
   */
  private async getWindowsAccentColor(): Promise<string | null> {
    try {
      const output = await this.execCommand(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\DWM" /v AccentColor'
      );
      const match = output.match(/AccentColor\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
      if (!match) return null;

      const rawHex = match[1].padStart(8, "0");
      // Byte offsets: [0..1 AA] [2..3 BB] [4..5 GG] [6..7 RR]
      const b = rawHex.slice(2, 4);
      const g = rawHex.slice(4, 6);
      const r = rawHex.slice(6, 8);

      return `#${r}${g}${b}`;
    } catch {
      return null;
    }
  }

  /**
   * macOS: Reads AppleHighlightColor or mapped AppleAccentColor constants.
   */
  private async getMacAccentColor(): Promise<string | null> {
    try {
      // 1. Try AppleHighlightColor (RGB values normalized 0.0 - 1.0)
      const highlightOutput = await this.execCommand("defaults read -g AppleHighlightColor");
      const parts = highlightOutput.trim().split(/\s+/);
      if (parts.length >= 3 && !isNaN(Number(parts[0]))) {
        const r = Math.round(parseFloat(parts[0]) * 255);
        const g = Math.round(parseFloat(parts[1]) * 255);
        const b = Math.round(parseFloat(parts[2]) * 255);
        return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
      }
    } catch {
      // Key may not exist if user hasn't customized highlight
    }

    try {
      // 2. Try AppleAccentColor indexed constants
      const accentOutput = (await this.execCommand("defaults read -g AppleAccentColor")).trim();
      const accentMap: Record<string, string> = {
        "-1": "#8e8e93", // Graphite
        "0": "#ff3b30",  // Red
        "1": "#ff9500",  // Orange
        "2": "#ffcc00",  // Yellow
        "3": "#34c759",  // Green
        "4": "#007aff",  // Blue (Standard)
        "5": "#af52de",  // Purple
        "6": "#ff2d55"   // Pink
      };
      if (accentMap[accentOutput]) {
        return accentMap[accentOutput];
      }
    } catch {
      // Fall through to CSS fallback
    }

    return null;
  }

  /**
   * Universal Fallback: Uses Chromium's AccentColor CSS system keyword.
   */
  private getCssSystemAccentColor(): string | null {
    try {
      const probe = document.createElement("div");
      probe.style.color = "AccentColor";
      probe.style.display = "none";
      document.body.appendChild(probe);

      const computed = getComputedStyle(probe).color;
      document.body.removeChild(probe);

      const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
        return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Applies the hex color to Obsidian's config and active DOM variables.
   */
  private applyAccentColor(hexColor: string): void {
    const customCss = (this.app as any).customCss;

    // Updates Obsidian internal appearance setting and recomputes theme palettes
    if (typeof customCss?.setAccentColor === "function") {
      customCss.setAccentColor(hexColor);
    } else if (typeof (this.app as any).vault?.setConfig === "function") {
      (this.app as any).vault.setConfig("accentColor", hexColor);
      customCss?.requestLoadTheme?.();
    }

    // Direct inline variable override for immediate rendering
    document.body.style.setProperty("--color-accent", hexColor);
  }

  /**
   * Event listeners: window focus, dark/light theme switch, and interval polling.
   */
  registerChangeListeners(): void {
    // Immediate check whenever user refocuses Obsidian (e.g. after changing OS settings)
    this.focusHandler = () => {
      if (this.settings.autoSync) {
        this.syncAccentColor();
      }
    };
    window.addEventListener("focus", this.focusHandler);

    // Watch OS color-scheme shifts
    this.mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
    this.mediaQueryHandler = () => {
      if (this.settings.autoSync) {
        this.syncAccentColor();
      }
    };
    this.mediaQueryList.addEventListener("change", this.mediaQueryHandler);

    // Background interval check for wallpaper/live accent adjustments
    this.restartPolling();
  }

  restartPolling(): void {
    this.stopPolling();
    if (!this.settings.autoSync) return;

    this.checkIntervalId = window.setInterval(() => {
      this.syncAccentColor();
    }, Math.max(1, this.settings.pollIntervalSec) * 1000);
  }

  stopPolling(): void {
    if (this.checkIntervalId !== null) {
      window.clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
  }

  /**
   * Safe desktop child_process runner.
   */
  private execCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const childProcess = (window as any).require?.("child_process");
      if (!childProcess?.exec) {
        return reject(new Error("child_process not available"));
      }

      childProcess.exec(command, (error: Error | null, stdout: string) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class OsAccentSettingTab extends PluginSettingTab {
  plugin: OsAccentColorPlugin;

  constructor(app: App, plugin: OsAccentColorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc("Listen for OS accent color changes and apply them automatically.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (val) => {
          this.plugin.settings.autoSync = val;
          await this.plugin.saveSettings();
          this.plugin.restartPolling();
        })
      );

    new Setting(containerEl)
      .setName("Polling interval (seconds)")
      .setDesc("How frequently to check the OS registry/defaults for wallpaper accent shifts.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.pollIntervalSec)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.pollIntervalSec = val;
            await this.plugin.saveSettings();
            this.plugin.restartPolling();
          })
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Manually trigger a sync with the current OS accent color.")
      .addButton((btn) =>
        btn.setButtonText("Sync").onClick(async () => {
          await this.plugin.syncAccentColor(true);
        })
      );
  }
}
