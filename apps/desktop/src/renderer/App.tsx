import React, { useState, useEffect } from "react";

export function App(): React.ReactElement {
  const [platform, setPlatform] = useState<string>("detecting...");
  const [pingStatus, setPingStatus] = useState<string>("waiting...");

  useEffect(() => {
    if (typeof window !== "undefined" && window.api) {
      setPlatform(window.api.platform);
      setPingStatus(window.api.ping());
    } else {
      setPlatform("browser/web");
      setPingStatus("preload bridge unavailable in browser preview");
    }
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-slate-950 text-slate-100 font-sans">
      <div className="w-full max-w-xl rounded-2xl bg-slate-900/80 p-8 shadow-2xl border border-slate-800 backdrop-blur-sm">
        <header className="mb-6 flex items-center space-x-3">
          <div className="h-4 w-4 rounded-full bg-emerald-500 shadow-lg shadow-emerald-500/50 animate-pulse" />
          <h1 className="text-2xl font-bold tracking-tight text-white">AI Desktop Shell</h1>
        </header>

        <p className="text-sm text-slate-400 mb-6 leading-relaxed">
          Electron desktop application shell active. The renderer runs in an isolated browser
          context without direct Node or Electron access, communicating strictly through the preload
          bridge.
        </p>

        <section className="space-y-3 rounded-lg bg-slate-950/60 p-4 border border-slate-800/80">
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Platform:</span>
            <span className="font-mono text-indigo-400 font-medium">{platform}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Bridge Status:</span>
            <span className="font-mono text-emerald-400 font-medium">{pingStatus}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Node Integration:</span>
            <span className="font-mono text-slate-400">Disabled (contextIsolation active)</span>
          </div>
        </section>

        <footer className="mt-8 pt-4 border-t border-slate-800 text-center text-xs text-slate-500">
          PR12 — Electron Shell Milestone
        </footer>
      </div>
    </main>
  );
}
