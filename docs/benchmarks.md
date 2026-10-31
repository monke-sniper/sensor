# Benchmarks

`npm run bench` builds the app, launches it, measures the numbers below and writes them to `docs/benchmarks.json`. Run it under `xvfb-run` on headless Linux.

## Latest run

These numbers come from a Linux container (4 vCPU Xeon 2.1 GHz, 16 GB RAM) with software rendering (`--disable-gpu`). Expect different absolute numbers on a Windows 11 desktop with a GPU. Use this run to compare builds, not to compare machines.

| Metric | Result |
|---|---|
| Launch to shell ready | 589 ms |
| Idle memory, all processes (working set) | 650 MB, 6 processes |
| Tab load, local page (median / p95) | 99 ms / 168 ms |
| Memory with 10 live tabs | 1692 MB, 16 processes |
| Memory after suspending the 10 background tabs | 690 MB (−1002 MB) |
| Tab switch (median) | 2.4 ms |
| Page → markdown (median) | 3.1 ms |
| Index 2,000 text files (worker thread) | 749 ms |
| Universal search over them (median / p95) | 3.0 ms / 3.9 ms |
| Local API round trip, named pipe/socket (median / p95) | 0.5 ms / 0.7 ms |

## Notes

- Memory is the sum of each process's working set, so shared pages are counted more than once. Treat it as an upper bound.
- Tab suspension (automatic after `browser.suspendAfterMinutes`, or **Suspend All Background Tabs**) is the biggest memory lever. Suspended tabs keep their place, title and URL and reload when shown.
- The palette overlay is a preloaded renderer (one process, roughly 60–80 MB) so `Ctrl+K` opens instantly. Loading it lazily would save that memory but cost about 300 ms on first open. It stays preloaded for now.
- Not measured yet: cold start on Windows, the Obsidian embedding cost, and long-session memory growth.
