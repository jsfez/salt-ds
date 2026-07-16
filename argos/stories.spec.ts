import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argosScreenshot } from "@argos-ci/playwright";
import { type Page, test } from "@playwright/test";

type StoryIndex = {
  entries: Record<
    string,
    { id: string; title: string; name: string; type: string }
  >;
};

const indexPath = fileURLToPath(
  new URL("../storybook-static/index.json", import.meta.url),
);
const index: StoryIndex = JSON.parse(readFileSync(indexPath, "utf-8"));

const only = process.env.ARGOS_ONLY?.split(",").map((s) => s.trim());

// Salt disables Chromatic snapshots globally and opts back in per story
// (`chromatic: { disableSnapshot: false }`), so the visual surface is the QA
// grids plus a few theme suites. Pre-filter by title to avoid loading a
// thousand docs-oriented stories, then confirm the parameter at runtime so
// the story's own opt-in stays the single source of truth.
const OPT_IN_TITLE =
  /(^|\/)QA$|\bQA$|^Core\/Style Injection$|^Highcharts\/Highcharts Theme$|^Ag Grid\/Ag Grid Theme$/;

// Mirror the two Chromatic modes: every opted-in story is captured with the
// brand (theme next) and legacy themes.
const THEMES = ["brand", "legacy"] as const;

// Loading indicators legitimately keep `aria-busy='true'` for as long as they
// are rendered, so waiting for it to clear never settles on their stories.
const LOADER = /load(ing|er)|skeleton|spinner|progress|busy/i;

const stories = Object.values(index.entries).filter(
  (entry) =>
    entry.type === "story" &&
    OPT_IN_TITLE.test(entry.title) &&
    (!only || only.includes(entry.id)),
);

// Wait for Storybook's own render cycle. Storybook 8+ exposes the active
// renders on `__STORYBOOK_PREVIEW__.storyRenders`; match the one for this
// story (fall back to the latest). Some stories render in a portal and
// leave #storybook-root empty, so don't wait on the root itself.
const waitForStoryRendered = (page: Page, storyId: string) =>
  page.waitForFunction((id) => {
    const renders =
      (
        window as unknown as {
          __STORYBOOK_PREVIEW__?: {
            storyRenders?: { id?: string; phase?: string }[];
          };
        }
      ).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
    const render =
      renders.find((r) => r.id === id) ?? renders[renders.length - 1];
    return render?.phase === "completed" || render?.phase === "finished";
  }, storyId);

for (const story of stories) {
  for (const theme of THEMES) {
    test(`${story.title} › ${story.name} [${theme}]`, async ({ page }) => {
      await page.goto(
        `/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`,
      );
      await waitForStoryRendered(page, story.id);
      // Honour the story's own Chromatic opt-in: only stories that set
      // `chromatic: { disableSnapshot: false }` are part of the visual surface.
      const optedIn = await page.evaluate((id) => {
        const renders =
          (
            window as unknown as {
              __STORYBOOK_PREVIEW__?: {
                storyRenders?: {
                  id?: string;
                  story?: {
                    parameters?: { chromatic?: { disableSnapshot?: boolean } };
                  };
                }[];
              };
            }
          ).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
        const render =
          renders.find((r) => r.id === id) ?? renders[renders.length - 1];
        return render?.story?.parameters?.chromatic?.disableSnapshot === false;
      }, story.id);
      test.skip(
        !optedIn,
        "story does not opt into snapshots (chromatic parameter)",
      );
      // Component code may measure text before the webfonts finish loading
      // (e.g. a tab activation indicator sized from getBoundingClientRect)
      // and only re-measure when a ResizeObserver fires. Wait for the fonts,
      // then nudge the viewport one pixel and back so size observers re-run
      // with the final font metrics.
      await page.evaluate(() => document.fonts.ready);
      const viewport = page.viewportSize();
      if (viewport) {
        await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
        await page.setViewportSize(viewport);
      }
      // Highcharts measures label widths once, when the chart is created; if
      // the webfonts land afterwards, axis label wrapping is decided from
      // fallback-font metrics and never reconsidered, so the same chart can
      // render two different layouts depending on font-load timing. Fonts are
      // final at this point (awaited above): remount the story so charts are
      // always built from the same metrics.
      if ((await page.locator(".highcharts-container").count()) > 0) {
        await page.evaluate((id) => {
          (
            window as unknown as {
              __STORYBOOK_PREVIEW__: {
                channel: { emit: (event: string, args: unknown) => void };
              };
            }
          ).__STORYBOOK_PREVIEW__.channel.emit("forceRemount", {
            storyId: id,
          });
        }, story.id);
        await waitForStoryRendered(page, story.id);
      }
      // Highcharts (and other JS-driven renderers) animate by mutating SVG
      // attributes on their own timeline; neither `prefers-reduced-motion` nor
      // CSS animation stabilization covers that, so a capture can land
      // mid-animation. Wait until the story markup holds still across two
      // consecutive samples, capped so endlessly looping stories still capture.
      let previousMarkup = "";
      let stableSamples = 0;
      for (let i = 0; i < 40 && stableSamples < 2; i++) {
        const markup = await page.evaluate(() => document.body.innerHTML);
        stableSamples = markup === previousMarkup ? stableSamples + 1 : 0;
        previousMarkup = markup;
        if (stableSamples < 2) await page.waitForTimeout(250);
      }
      // Scrollable containers (carousels, overflowing lists) may settle on a
      // non-deterministic offset: pin every scroll position before capturing.
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("*"))) {
          if (el.scrollLeft !== 0) el.scrollLeft = 0;
          if (el.scrollTop !== 0) el.scrollTop = 0;
        }
      });
      // SVG SMIL animations (`<animate>`) ignore `prefers-reduced-motion` and
      // aren't covered by Argos's animation stabilization, so a capture lands
      // at an arbitrary point of the timeline. Rewind them to their base state
      // and pause.
      await page.evaluate(() => {
        for (const svg of Array.from(document.querySelectorAll("svg"))) {
          if (typeof svg.pauseAnimations !== "function") continue;
          svg.setCurrentTime(0);
          svg.pauseAnimations();
        }
      });
      const isLoader = LOADER.test(`${story.title} ${story.name}`);
      await argosScreenshot(page, `${story.id} [${theme}]`, {
        stabilize: { waitForAriaBusy: !isLoader },
      });
    });
  }
}
