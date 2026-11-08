import { test } from "@playwright/test";
import { completeSetup, launchApp, waitForDashboard } from "./app";

/**
 * Temporary, measurement-only harness for the performance audit.
 *
 * It seeds a catalogue, then records:
 *  - how many RPC calls a theme switch causes,
 *  - frame pacing while the rail collapses,
 *  - frame pacing while the page scrolls,
 *  - style/layout work from Chromium's own counters.
 *
 * It asserts nothing: the numbers are printed so the same test can be run
 * before and after an optimisation and compared.
 */

test("performance audit measurements", async () => {
  test.skip(process.env["PERF_AUDIT"] !== "1", "set PERF_AUDIT=1 to run the audit");
  test.setTimeout(240_000);

  const testApp = await launchApp();
  const page = testApp.window;
  await page.setViewportSize({ width: 1440, height: 900 });
  await completeSetup(page);
  await waitForDashboard(page);

  // Seed enough rows for the catalogue list and the dashboard to do real work.
  const seeded = await page.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (m: string, p: unknown) => Promise<{ ok: boolean }> };
    }).api;
    let count = 0;
    for (let index = 0; index < 160; index += 1) {
      const result = await api.invoke("products.save", {
        name: `Audit filter ${String(index).padStart(3, "0")}`,
        category: index % 3 === 0 ? "Filters" : index % 3 === 1 ? "Fittings" : "Spares",
        unit: "pcs",
        salePriceFils: 10_000 + index * 100,
        openingQuantityMilli: (index % 20) * 1000,
      });
      if (result.ok) count += 1;
    }
    return count;
  });

  await page.waitForTimeout(1_500);

  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");

  const metrics = async (): Promise<Record<string, number>> => {
    const result = await client.send("Performance.getMetrics");
    return Object.fromEntries(result.metrics.map((entry) => [entry.name, entry.value]));
  };

  const diff = (
    before: Record<string, number>,
    after: Record<string, number>,
    key: string,
  ): number => (after[key] ?? 0) - (before[key] ?? 0);

  const patchRpc = await page.evaluate(async () => {
    const api = (window as unknown as { api?: { invoke: unknown } }).api;
    if (api === undefined) return { patched: false, probeCount: 0 };
    const descriptor = Object.getOwnPropertyDescriptor(window, "api");
    const frozen = Object.isFrozen(api);
    const original = api.invoke as (method: string, payload: unknown) => Promise<unknown>;
    const log: { method: string; at: number }[] = [];
    (window as unknown as { __perfRpc: typeof log }).__perfRpc = log;
    try {
      api.invoke = async (method: string, payload: unknown) => {
        log.push({ method, at: performance.now() });
        return original(method, payload);
      };
    } catch {
      return { patched: false, probeCount: 0, descriptor, frozen };
    }
    await (api.invoke as (method: string, payload: unknown) => Promise<unknown>)(
      "settings.get",
      {},
    );
    return { patched: api.invoke !== original, probeCount: log.length, descriptor, frozen };
  });

  const ipcPatch = await testApp.app.evaluate((electron) => {
    const handlers = (
      electron.ipcMain as unknown as {
        _invokeHandlers?: Map<string, (event: unknown, payload: unknown) => unknown>;
      }
    )._invokeHandlers;
    if (handlers === undefined) return { patched: false, channels: [] as string[] };
    const original = handlers.get("api:invoke");
    if (original === undefined) return { patched: false, channels: [...handlers.keys()] };
    const calls: { method: string; at: number }[] = [];
    (globalThis as unknown as { __perfCalls: typeof calls }).__perfCalls = calls;
    handlers.set("api:invoke", (event, payload) => {
      const request = payload as { method?: unknown };
      calls.push({ method: String(request.method), at: Date.now() });
      return original(event, payload);
    });
    return { patched: true, channels: [...handlers.keys()] };
  });

  await page.evaluate(() => {
    const entries: { start: number; duration: number }[] = [];
    (window as unknown as { __perfLong: typeof entries }).__perfLong = entries;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          entries.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* not supported */
    }
  });

  await testApp.app.evaluate(() => {
    (globalThis as unknown as { __perfCalls: unknown[] }).__perfCalls.length = 0;
  });
  const beforeTheme = await metrics();
  const theme = await page.evaluate(async () => {
    const nextFrame = (): Promise<number> =>
      new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    const log = (window as unknown as { __perfRpc: { method: string; at: number }[] }).__perfRpc;
    const long = (window as unknown as { __perfLong: { start: number; duration: number }[] })
      .__perfLong;
    log.length = 0;
    long.length = 0;

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Theme:"]');
    if (trigger === null) return { error: "theme trigger not found" };
    trigger.click();
    await nextFrame();
    await nextFrame();

    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((entry) => entry.textContent?.includes("Dark"));
    if (item === undefined) return { error: "dark menu item not found" };

    const clickAt = performance.now();
    item.click();

    const frames: number[] = [];
    let previous = performance.now();
    let classAt: number | null = null;

    for (let index = 0; index < 90; index += 1) {
      await nextFrame();
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
      if (classAt === null && document.documentElement.classList.contains("dark")) {
        classAt = now - clickAt;
      }
    }

    await sleep(1_500);

    return {
      classAtMs: classAt === null ? null : +classAt.toFixed(1),
      calls: log.map((entry) => ({
        method: entry.method,
        atMs: +(entry.at - clickAt).toFixed(1),
      })),
      longTasks: long
        // The click is dispatched inside the current task, so a task that
        // starts just before `clickAt` and runs through the theme swap is
        // still the one the user waits on. Overlap, not start time.
        .filter((entry) => entry.start + entry.duration >= clickAt)
        .map((entry) => ({
          atMs: +Math.max(0, entry.start - clickAt).toFixed(1),
          durationMs: +entry.duration.toFixed(1),
        })),
      frames: {
        count: frames.length,
        maxMs: +Math.max(...frames).toFixed(1),
        over20: frames.filter((value) => value > 20).length,
        over33: frames.filter((value) => value > 33).length,
      },
    };
  });
  const afterTheme = await metrics();
  const themeCalls = await testApp.app.evaluate(() =>
    (globalThis as unknown as { __perfCalls: { method: string }[] }).__perfCalls.map(
      (entry) => entry.method,
    ),
  );

  // The same switch with reduced motion: this is the immediate path, and it
  // isolates what the view-transition snapshot itself costs.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await testApp.app.evaluate(() => {
    (globalThis as unknown as { __perfCalls: unknown[] }).__perfCalls.length = 0;
  });
  const themeReduced = await page.evaluate(async () => {
    const nextFrame = (): Promise<number> =>
      new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Theme:"]');
    if (trigger === null) return { error: "theme trigger not found" };
    trigger.click();
    await nextFrame();
    await nextFrame();

    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((entry) => entry.textContent?.includes("Light"));
    if (item === undefined) return { error: "light menu item not found" };

    const clickAt = performance.now();
    item.click();

    const frames: number[] = [];
    let previous = performance.now();
    let classAt: number | null = null;

    for (let index = 0; index < 60; index += 1) {
      await nextFrame();
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
      if (classAt === null && !document.documentElement.classList.contains("dark")) {
        classAt = now - clickAt;
      }
    }

    await sleep(500);

    return {
      classAtMs: classAt === null ? null : +classAt.toFixed(1),
      frames: {
        count: frames.length,
        maxMs: +Math.max(...frames).toFixed(1),
        over20: frames.filter((value) => value > 20).length,
        over33: frames.filter((value) => value > 33).length,
      },
    };
  });
  const themeReducedCalls = await testApp.app.evaluate(() =>
    (globalThis as unknown as { __perfCalls: { method: string }[] }).__perfCalls.map(
      (entry) => entry.method,
    ),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await testApp.app.evaluate(() => {
    (globalThis as unknown as { __perfCalls: unknown[] }).__perfCalls.length = 0;
  });
  const beforeSidebar = await metrics();
  const sidebar = await page.evaluate(async () => {
    const nextFrame = (): Promise<number> =>
      new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse menu"]',
    );
    if (trigger === null) return { error: "collapse trigger not found" };

    const frames: number[] = [];
    let previous = performance.now();
    trigger.click();

    for (let index = 0; index < 42; index += 1) {
      await nextFrame();
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }

    return {
      frames: {
        count: frames.length,
        maxMs: +Math.max(...frames).toFixed(1),
        over20: frames.filter((value) => value > 20).length,
        over33: frames.filter((value) => value > 33).length,
      },
    };
  });
  const afterSidebar = await metrics();

  await page.waitForTimeout(500);
  await page.getByRole("link", { name: /^products$/i }).first().click();
  await page.getByRole("heading", { name: "Products" }).last().waitFor();
  await page.getByRole("combobox", { name: "products per page" }).click();
  await page.getByRole("option", { name: "100 / page" }).click();
  await page.waitForTimeout(500);

  const beforeScroll = await metrics();
  const scroll = await page.evaluate(async () => {
    const nextFrame = (): Promise<number> =>
      new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });

    const main = document.querySelector("main") as HTMLElement;
    const frames: number[] = [];
    let previous = performance.now();
    const steps = 90;

    for (let index = 0; index < steps; index += 1) {
      const max = main.scrollHeight - main.clientHeight;
      main.scrollTop = (max * index) / (steps - 1);
      await nextFrame();
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }

    return {
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
      frames: {
        count: frames.length,
        maxMs: +Math.max(...frames).toFixed(1),
        over20: frames.filter((value) => value > 20).length,
        over33: frames.filter((value) => value > 33).length,
      },
    };
  });
  const afterScroll = await metrics();

  console.error(
    "PERF_AUDIT",
    JSON.stringify(
      {
        seeded,
        rpcPatched: patchRpc,
        ipcPatch,
        theme,
        themeCalls,
        themeReduced,
        themeReducedCalls,
        themeMetrics: {
          styleRecalc: diff(beforeTheme, afterTheme, "RecalcStyleCount"),
          layout: diff(beforeTheme, afterTheme, "LayoutCount"),
          taskDurationMs: +(diff(beforeTheme, afterTheme, "TaskDuration") * 1000).toFixed(1),
        },
        sidebar,
        sidebarMetrics: {
          styleRecalc: diff(beforeSidebar, afterSidebar, "RecalcStyleCount"),
          layout: diff(beforeSidebar, afterSidebar, "LayoutCount"),
          taskDurationMs: +(diff(beforeSidebar, afterSidebar, "TaskDuration") * 1000).toFixed(1),
        },
        scroll,
        scrollMetrics: {
          styleRecalc: diff(beforeScroll, afterScroll, "RecalcStyleCount"),
          layout: diff(beforeScroll, afterScroll, "LayoutCount"),
          taskDurationMs: +(diff(beforeScroll, afterScroll, "TaskDuration") * 1000).toFixed(1),
        },
      },
      null,
      2,
    ),
  );

  await testApp.close();
});
