/// <reference types="vite/client" />

/** Computed from the program source at build time; see vite.config.ts. */
declare const __VINCT_BUILD_FINGERPRINT__: string;
declare const __VINCT_BUILT_AT__: string;

interface ImportMetaEnv {
  /** Solana Devnet RPC. Public by nature; never a credentialed URL. */
  readonly VITE_SOLANA_RPC?: string;
  /** A first rollup candidate. Routing still decides, and may disagree. */
  readonly VITE_MAGICBLOCK_ER?: string;
  readonly VITE_MAGICBLOCK_ROUTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
