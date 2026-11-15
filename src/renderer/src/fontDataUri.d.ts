// UI-FONTS-LOCAL: see fontDataUri in electron.vite.config.ts.
declare module '*.woff2?datauri' {
  const dataUri: string;
  export default dataUri;
}
