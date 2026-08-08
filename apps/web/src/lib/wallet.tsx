/**
 * Who is holding the browser, and what that entitles them to.
 *
 * Two rules shape this file.
 *
 * Reading never needs a wallet. Every public surface, the demo, and the whole proof path work
 * disconnected, because a judge should not have to install anything to check the work.
 *
 * An action a wallet cannot perform is never offered. VINCT's authority model is specific:
 * the steward convenes, each protocol ratifies and arms only its own membership, and only a
 * member of a frozen set can answer an incident. A button that looks available and fails in a
 * wallet teaches somebody the product is broken when it is doing exactly what it promised.
 *
 * The connection uses the injected provider that Phantom, Solflare, and Backpack all expose,
 * rather than the wallet-adapter package set. That is a deliberate trade: it is a few hundred
 * lines lighter, it has no React context of its own to fight, and it covers the wallets a judge
 * will actually have. It does not cover hardware-only or deep-link mobile wallets, and the
 * connect surface says so rather than failing silently.
 */

import { PublicKey } from "@solana/web3.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface InjectedProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toBytes(): Uint8Array } | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
}

interface WalletWindow {
  solana?: InjectedProvider;
  solflare?: InjectedProvider;
  backpack?: InjectedProvider;
}

export interface DetectedWallet {
  id: "phantom" | "solflare" | "backpack" | "injected";
  name: string;
  provider: InjectedProvider;
}

/** Every provider this browser exposes, named so a picker can be honest about the choice. */
export function detectWallets(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  const w = window as unknown as WalletWindow;
  const found: DetectedWallet[] = [];
  if (w.solana?.isPhantom) found.push({ id: "phantom", name: "Phantom", provider: w.solana });
  if (w.solflare) found.push({ id: "solflare", name: "Solflare", provider: w.solflare });
  if (w.backpack) found.push({ id: "backpack", name: "Backpack", provider: w.backpack });
  if (found.length === 0 && w.solana) {
    found.push({ id: "injected", name: "Browser wallet", provider: w.solana });
  }
  return found;
}

export interface WalletState {
  available: DetectedWallet[];
  connecting: boolean;
  publicKey: PublicKey | null;
  walletName: string | null;
  error: string | null;
  connect: (id?: DetectedWallet["id"]) => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

const REMEMBERED = "vinct.wallet";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState<DetectedWallet[]>([]);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Providers inject asynchronously, so detection runs again shortly after mount. Detecting
  // once on load reports "no wallet found" to people who have one.
  useEffect(() => {
    const scan = (): void => setAvailable(detectWallets());
    scan();
    const timer = setTimeout(scan, 600);
    window.addEventListener("load", scan);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("load", scan);
    };
  }, []);

  const connect = useCallback(async (id?: DetectedWallet["id"]) => {
    setError(null);
    const wallets = detectWallets();
    const chosen = id ? wallets.find((w) => w.id === id) : wallets[0];
    if (!chosen) {
      setError("No Solana wallet is available in this browser.");
      return;
    }
    setConnecting(true);
    try {
      const result = await chosen.provider.connect();
      setPublicKey(new PublicKey(result.publicKey.toBytes()));
      setWalletName(chosen.name);
      // Only the wallet's name, so a reload can reconnect silently. Never a key.
      try {
        window.localStorage.setItem(REMEMBERED, chosen.id);
      } catch {
        // Storage disabled is fine; the next visit asks again.
      }
    } catch (cause) {
      // A user closing the wallet popup is not an error worth shouting about.
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(/reject|denied|cancel/i.test(message) ? null : message);
    } finally {
      setConnecting(false);
    }
  }, []);

  // Reconnect without a prompt when the wallet already trusts this origin.
  useEffect(() => {
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(REMEMBERED);
    } catch {
      remembered = null;
    }
    if (!remembered) return;
    const wallets = detectWallets();
    const chosen = wallets.find((w) => w.id === remembered);
    if (!chosen) return;
    void chosen.provider
      .connect({ onlyIfTrusted: true })
      .then((result) => {
        setPublicKey(new PublicKey(result.publicKey.toBytes()));
        setWalletName(chosen.name);
      })
      .catch(() => {
        // Not trusted yet. The connect button still works.
      });
  }, [available.length]);

  const disconnect = useCallback(async () => {
    const wallets = detectWallets();
    for (const wallet of wallets) {
      try {
        await wallet.provider.disconnect();
      } catch {
        // A provider that will not disconnect should not trap the interface.
      }
    }
    setPublicKey(null);
    setWalletName(null);
    try {
      window.localStorage.removeItem(REMEMBERED);
    } catch {
      // Nothing to clean up.
    }
  }, []);

  const value = useMemo<WalletState>(
    () => ({ available, connecting, publicKey, walletName, error, connect, disconnect }),
    [available, connecting, publicKey, walletName, error, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside a WalletProvider");
  return context;
}

/**
 * What a connected wallet is, relative to one covenant.
 *
 * Deliberately not a single boolean. A wallet that is connected and unrelated to the covenant
 * being viewed is a different situation from a disconnected one, and both are different from a
 * member who can answer an incident. Each gets its own message.
 */
export type Role =
  | { kind: "disconnected" }
  | { kind: "unrelated"; address: PublicKey }
  | { kind: "steward"; address: PublicKey }
  | { kind: "member"; address: PublicKey; ratified: boolean; armed: boolean }
  /** A member of the covenant and of this incident's frozen set. */
  | { kind: "responder"; address: PublicKey };

export function describeRole(role: Role): string {
  switch (role.kind) {
    case "disconnected":
      return "Not connected";
    case "unrelated":
      return "Observer";
    case "steward":
      return "Steward";
    case "member":
      return "Protocol authority";
    case "responder":
      return "Incident member";
  }
}
