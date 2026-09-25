import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

interface OsAccentPluginSettings {
  autoSync: boolean;
  pollIntervalSec: number;
  useExplorerAccentFallback: boolean;
  originalAccentColor?: string | null;
}

const DEFAULT_SETTINGS: OsAccentPluginSettings = {
  autoSync: true,
  pollIntervalSec: 10,
  useExplorerAccentFallback: false
};

const MIN_ACCENT_LUMINANCE = 0.18;
const MAX_ACCENT_LUMINANCE = 0.82;
const MAX_GREY_ACCENT_CHROMA = 0.15;

function getRelativeLuminance(red: number, green: number, blue: number): number {
  const linearize = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

function adjustAccentColor(hexColor: string): string {
  const match = hexColor.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return hexColor;

  const channels = match[1].match(/.{2}/g)?.map((channel) => parseInt(channel, 16));
  if (!channels || channels.length !== 3) return hexColor;

  const luminance = getRelativeLuminance(channels[0], channels[1], channels[2]);
  if (luminance >= MIN_ACCENT_LUMINANCE && luminance <= MAX_ACCENT_LUMINANCE) {
    return `#${match[1]}`;
  }

  const lighten = luminance < MIN_ACCENT_LUMINANCE;
  const targetLuminance = lighten ? MIN_ACCENT_LUMINANCE : MAX_ACCENT_LUMINANCE;
  let lowerAmount = 0;
  let upperAmount = 1;

  for (let iteration = 0; iteration < 8; iteration++) {
    const amount = (lowerAmount + upperAmount) / 2;
    const adjusted = channels.map((channel) =>
      Math.round(lighten ? channel + (255 - channel) * amount : channel * (1 - amount))
    );
    const adjustedLuminance = getRelativeLuminance(adjusted[0], adjusted[1], adjusted[2]);

    if ((lighten && adjustedLuminance < targetLuminance) || (!lighten && adjustedLuminance > targetLuminance)) {
      lowerAmount = amount;
    } else {
      upperAmount = amount;
    }
  }

  const adjusted = channels.map((channel) =>
    Math.round(lighten ? channel + (255 - channel) * upperAmount : channel * (1 - upperAmount))
  );
  return `#${adjusted.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

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
    if (this.settings.autoSync) {
      await this.syncAccentColor();
    }

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
    this.restoreAccentColor();

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
    await this.captureOriginalAccentColor();
    const hexColor = await this.getSystemAccentColor();
    if (!hexColor) return;

    const adjustedColor = adjustAccentColor(hexColor);
    if (force || adjustedColor.toLowerCase() !== this.lastAppliedColor?.toLowerCase()) {
      this.applyAccentColor(adjustedColor);
      this.lastAppliedColor = adjustedColor;
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
      const winColor = this.parseWindowsAccentColor(output, "AccentColor");
      if (!winColor || !this.settings.useExplorerAccentFallback || !this.isGreyAccent(winColor)) {
        return winColor;
      }

      try {
        const explorerOutput = await this.execCommand(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent" /v StartColorMenu'
        );
        return this.parseWindowsAccentColor(explorerOutput, "StartColorMenu") ?? winColor;
      } catch {
        return winColor;
      }
    } catch {
      return null;
    }
  }

  private parseWindowsAccentColor(output: string, valueName: string): string | null {
    const match = output.match(new RegExp(`${valueName}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`));
    if (!match) return null;

    const rawHex = match[1].padStart(8, "0");
    // Windows stores the color as AABBGGRR.
    return `#${rawHex.slice(6, 8)}${rawHex.slice(4, 6)}${rawHex.slice(2, 4)}`;
  }

  private isGreyAccent(hexColor: string): boolean {
    const channels = hexColor.match(/^#?([0-9a-f]{6})$/i)?.[1].match(/.{2}/g)?.map((channel) =>
      parseInt(channel, 16)
    );
    if (!channels || channels.length !== 3) return false;

    const maximum = Math.max(...channels);
    if (maximum === 0) return true;
    return (maximum - Math.min(...channels)) / maximum <= MAX_GREY_ACCENT_CHROMA;
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

  private async captureOriginalAccentColor(): Promise<void> {
    if (this.settings.originalAccentColor !== undefined) return;

    const currentColor = (this.app as any).vault?.getConfig?.("accentColor");
    this.settings.originalAccentColor = typeof currentColor === "string" ? currentColor : null;
    await this.saveSettings();
  }

  restoreAccentColor(): void {
    const originalColor = this.settings.originalAccentColor;
    if (originalColor === undefined) return;

    const vault = (this.app as any).vault;
    const customCss = (this.app as any).customCss;
    if (originalColor === null) {
      vault?.setConfig?.("accentColor", null);
      customCss?.requestLoadTheme?.();
      document.body.style.removeProperty("--color-accent");
    } else {
      this.applyAccentColor(originalColor);
    }

    this.settings.originalAccentColor = undefined;
    void this.saveSettings();
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
          if (val) {
            await this.plugin.syncAccentColor();
          } else {
            this.plugin.restoreAccentColor();
          }
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
      .setName("Use Windows fallback for grey accents")
      .setDesc("When the Windows accent is nearly grey, use Explorer's AccentColorMenu registry color instead.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useExplorerAccentFallback).onChange(async (val) => {
          this.plugin.settings.useExplorerAccentFallback = val;
          await this.plugin.saveSettings();
          await this.plugin.syncAccentColor();
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
