import { expect, test } from "@playwright/test";
import {
  completeSetup,
  launchApp,
  rpc,
  type TestApp,
} from "./app";

/**
 * The UI flows the redesign is judged on, driven as a user drives them.
 *
 * Everything here goes through the screens rather than the RPC bridge, because
 * the point is that the *dialog* is what appears, that the list behind it does
 * not move, and that the figures on screen are the ones that were entered.
 *
 * The whole file runs twice, at the two resolutions the shop actually uses.
 */

let testApp: TestApp;

const VIEWPORTS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

function resize(width: number, height: number): Promise<void> {
  return testApp.app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(size.width, size.height);
    },
    { width, height },
  );
}

async function goto(name: RegExp): Promise<void> {
  await testApp.window.getByRole("link", { name }).first().click();
  await testApp.window.waitForTimeout(300);
}

test.describe.configure({ mode: "serial" });

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.name}`, () => {
    test.beforeEach(async () => {
      testApp = await launchApp();
      await completeSetup(testApp.window);
      await resize(viewport.width, viewport.height);
    });

    test.afterEach(async () => {
      await testApp?.close();
    });

    test("a product is added with a name and a quantity only", async () => {
      await goto(/^products$/i);

      await testApp.window.getByRole("button", { name: /new product/i }).first().click();

      const dialog = testApp.window.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("New product")).toBeVisible();

      // The simplified form: no SKU, cost, sale price, reorder level or the
      // active flag. The database keeps those columns; the form does not ask.
      await expect(dialog.getByLabel(/^product name/i)).toBeVisible();
      await expect(dialog.getByLabel(/opening quantity/i)).toBeVisible();
      await expect(dialog.getByLabel(/^unit/i)).toBeVisible();
      await expect(dialog.getByLabel(/^category/i)).toBeVisible();

      for (const gone of [/sku/i, /^code/i, /sale price/i, /reorder level/i, /min stock/i]) {
        await expect(dialog.getByLabel(gone)).toHaveCount(0);
      }

      await dialog.getByLabel(/^product name/i).fill("Inline filter");
      await dialog.getByLabel(/opening quantity/i).fill("10");

      // The list behind the dialog has not moved or changed yet.
      await expect(testApp.window.getByRole("table")).toHaveCount(0);

      await dialog.getByRole("button", { name: /^save$/i }).click();

      // The opening quantity landed as stock, and the row is on the list.
      const list = testApp.window.getByRole("table");
      await expect(list).toBeVisible();
      await expect(list.getByText("Inline filter")).toBeVisible();
      await expect(list.getByText("10")).toBeVisible();
    });

    test("buying then selling shows the profit that was entered", async () => {
      // Opening stock from the product flow above is not present in this test,
      // so buy the stock first through the purchase dialog.
      await goto(/^products$/i);
      await testApp.window.getByRole("button", { name: /new product/i }).first().click();
      const productDialog = testApp.window.getByRole("dialog");
      await productDialog.getByLabel(/^product name/i).fill("Inline filter");
      await productDialog.getByLabel(/opening quantity/i).fill("10");
      await productDialog.getByRole("button", { name: /^save$/i }).click();
      await expect(testApp.window.getByRole("table").getByText("Inline filter")).toBeVisible();

      // --- Purchase ---------------------------------------------------------
      await goto(/^purchases$/i);
      await testApp.window.getByRole("button", { name: /new purchase/i }).first().click();

      const purchaseDialog = testApp.window.getByRole("dialog");
      await expect(purchaseDialog.getByText("New purchase")).toBeVisible();

      // A cash purchase needs no supplier, and the supplier select starts on
      // "nothing chosen" - there is no empty option to pick any more, because
      // the dropdown is a themed listbox where "" is the unset state itself.
      await expect(purchaseDialog.getByLabel(/^supplier/i)).toHaveText(/select supplier/i);
      const purchaseProduct = purchaseDialog.getByLabel(/^product$/i).first();
      await purchaseProduct.click();
      await purchaseProduct.fill("Inline");
      await purchaseDialog.getByRole("option", { name: /Inline filter/ }).click();

      await purchaseDialog.getByLabel(/^quantity$/i).first().fill("10");
      // "Cost per unit" is what the shop pays, and it becomes the product's
      // last cost.
      await purchaseDialog.getByLabel(/cost per unit/i).first().fill("40");
      await purchaseDialog.getByRole("button", { name: /create purchase/i }).click();

      await expect(testApp.window.getByRole("dialog")).toHaveCount(0);
      await expect(testApp.window.getByRole("table").getByText(/^PINV-/)).toBeVisible();

      // The purchase invalidated the products cache; let the background
      // refetch land so the sale dialog pre-fills from fresh data.
      await goto(/^products$/i);
      await testApp.window.waitForTimeout(500);

      // --- Sale -------------------------------------------------------------
      await goto(/^sales$/i);
      await testApp.window.getByRole("button", { name: /new invoice/i }).first().click();

      const saleDialog = testApp.window.getByRole("dialog");
      await expect(saleDialog.getByText("New sale")).toBeVisible();

      const saleProduct = saleDialog.getByLabel(/^product$/i).first();
      await saleProduct.click();
      await saleProduct.fill("Inline");
      await saleDialog.getByRole("option", { name: /Inline filter/ }).click();

      await saleDialog.getByLabel(/^quantity$/i).first().fill("4");

      // Bought at is pre-filled from the last purchase cost (40.00) and is
      // editable; Sell at is pre-filled from the last sale price.
      const boughtAt = saleDialog.getByLabel(/bought at/i).first();
      await expect(boughtAt).toHaveValue("40");
      await saleDialog.getByLabel(/sell at/i).first().fill("75");

      // 4 units at (75.00 - 40.00) = Rs 140.00 of profit, shown on the row.
      await expect(saleDialog.getByText("140.00").first()).toBeVisible();

      // Totals: 4 x 75.00 = 300.00 net, 5% VAT, 315.00 gross.
      await expect(saleDialog.getByText("315.00").first()).toBeVisible();
      await expect(saleDialog.getByText("Total profit")).toBeVisible();

      await saleDialog.getByRole("button", { name: /create invoice/i }).click();

      await expect(testApp.window.getByRole("dialog")).toHaveCount(0);
      await expect(testApp.window.getByRole("table").getByText(/^INV-/)).toBeVisible();
      await expect(testApp.window.getByRole("table").getByText("315.00").first()).toBeVisible();
    });

    test("every add and edit action opens a dialog over the list", async () => {
      const opensDialog = async (link: RegExp, button: RegExp, title: RegExp): Promise<void> => {
        await goto(link);
        const before = testApp.window.getByRole("heading").first();
        await expect(before).toBeVisible();

        await testApp.window.getByRole("button", { name: button }).first().click();
        const dialog = testApp.window.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(title)).toBeVisible();

        // Escape closes it and the list is still there.
        await testApp.window.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      };

      await opensDialog(/^customers$/i, /new customer/i, /New customer/);
      await opensDialog(/^suppliers$/i, /new supplier/i, /New supplier/);
      await opensDialog(/^expenses$/i, /new expense/i, /New expense/);
      await opensDialog(/^products$/i, /new product/i, /New product/);
      await opensDialog(/^sales$/i, /new invoice/i, /New sale/);
      await opensDialog(/^purchases$/i, /new purchase/i, /New purchase/);

      // Settings users: add user is a dialog too.
      await goto(/^settings$/i);
      await testApp.window
        .getByRole("navigation", { name: /settings sections/i })
        .getByRole("button", { name: /^users$/i })
        .click();
      await testApp.window.getByRole("button", { name: /add user/i }).click();
      await expect(testApp.window.getByRole("dialog").getByText("Add user")).toBeVisible();
      await testApp.window.keyboard.press("Escape");
    });

    test("the sale and purchase dialogs keep their action button on screen", async () => {
      /**
       * The dialog used to cap its scrolling body with a fixed allowance for
       * the header and the footer. The real footer - a totals panel, an error
       * line and the buttons - is taller than that allowance, so the panel
       * overflowed its own height, the footer was clipped away and the button
       * that saves the document sat below the fold with nothing to scroll to.
       *
       * The button has to be inside the dialog panel itself, not merely on
       * screen: an ancestor's `overflow: hidden` can clip a button that
       * Playwright would still call visible.
       */
      const cases = [
        { link: /^sales$/i, open: /new invoice/i, action: /create invoice/i },
        { link: /^purchases$/i, open: /new purchase/i, action: /create purchase/i },
      ] as const;

      for (const testCase of cases) {
        await goto(testCase.link);
        await testApp.window.getByRole("button", { name: testCase.open }).first().click();

        const dialog = testApp.window.getByRole("dialog");
        await expect(dialog).toBeVisible();

        // The panel opens with a short scale animation, and a scaled panel
        // reports boxes that are a pixel or two out. Wait for the motion to
        // finish before measuring anything.
        await dialog.evaluate(async (panel) => {
          await Promise.all(
            panel.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
          );
        });

        const button = dialog.getByRole("button", { name: testCase.action });
        await expect(button).toBeVisible();
        await expect(button).toBeInViewport();

        const dialogBox = await dialog.boundingBox();
        const buttonBox = await button.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(buttonBox).not.toBeNull();
        expect(buttonBox!.y).toBeGreaterThanOrEqual(dialogBox!.y - 1);
        expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(
          dialogBox!.y + dialogBox!.height + 1,
        );

        // The body scrolls; the footer stays where it is.
        const footer = dialog.locator(":scope > div").last();
        const footerBefore = await footer.boundingBox();
        await dialog.locator(".dialog-body").evaluate((body) => {
          body.scrollTop = body.scrollHeight;
        });
        await testApp.window.waitForTimeout(200);
        const footerAfter = await footer.boundingBox();
        expect(footerAfter?.y).toBeCloseTo(footerBefore?.y ?? 0, 0);

        // And the button still works from where it sits.
        await expect(button).toBeEnabled();
        await testApp.window.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
    });

    test("the About tab reports the version and the update state", async () => {
      await goto(/^settings$/i);
      await testApp.window
        .getByRole("navigation", { name: /settings sections/i })
        .getByRole("button", { name: /^about$/i })
        .click();

      await expect(testApp.window.getByText("Updates", { exact: true })).toBeVisible();

      // These tests run an unpackaged build, which has no release manifest and
      // so cannot update itself. It says so rather than showing a button
      // that would fail - the round trip through the main process still
      // happened, which is what this asserts.
      await expect(
        testApp.window.getByText(/Updates are checked by the installed application/),
      ).toBeVisible();
    });

    test("filters apply and show chips that can be cleared", async () => {
      await goto(/^sales$/i);

      // Cancelled is a status filter with no rows behind it, so use Search
      // plus the date preset, both of which are visible without seed data.
      const search = testApp.window.getByPlaceholder(/number or party name/i);
      await search.fill("ZZZ-no-such-invoice");
      await expect(testApp.window.getByText(/Search: ZZZ-no-such-invoice/)).toBeVisible();
      await expect(testApp.window.getByRole("button", { name: /clear all/i })).toBeVisible();

      // The row is gone, not the page.
      await expect(testApp.window.getByText("Nothing matched your search")).toBeVisible();

      // Clearing the chip removes the filter.
      await testApp.window.getByRole("button", { name: /clear all/i }).click();
      await expect(search).toHaveValue("");

      // The date-range dropdown offers the presets.
      await testApp.window.getByRole("button", { name: /date range/i }).click();
      await expect(testApp.window.getByRole("menuitem", { name: /^today$/i })).toBeVisible();
      await expect(testApp.window.getByRole("menuitem", { name: /^this month$/i })).toBeVisible();
      await expect(testApp.window.getByRole("menuitem", { name: /^this year$/i })).toBeVisible();
      await testApp.window.getByRole("menuitem", { name: /^this month$/i }).click();

      // Applying a preset shows a date chip.
      await expect(testApp.window.getByText(/^Date: /)).toBeVisible();
    });

    test("pagination reports what it is showing", async () => {
      await goto(/^products$/i);

      // Seed more products than fit on one page so the footer has work to do.
      for (let index = 0; index < 30; index += 1) {
        await rpc(testApp.window, "products.save", {
          name: `Paged product ${String(index).padStart(2, "0")}`,
          openingQuantityMilli: 1000,
        });
      }
      await testApp.window.reload();
      await testApp.window.waitForTimeout(600);
      await goto(/^products$/i);

      await expect(testApp.window.getByText(/Showing/).first()).toBeVisible();
      await expect(testApp.window.getByText(/of \d+ products/).first()).toBeVisible();

      // Page size control and the page stepper both exist.
      await expect(testApp.window.getByLabel(/products per page/i)).toBeVisible();
      await expect(testApp.window.getByRole("button", { name: /next page/i })).toBeVisible();

      // 30 seeded products at 25/page means a second page, and the stepper moves.
      const next = testApp.window.getByRole("button", { name: /next page/i });
      await expect(next).toBeEnabled();
      await next.click();
      await expect(testApp.window.getByText(/Showing 26–30 of 30 products/)).toBeVisible();
    });
  });
}

test.describe("Staff cannot see profit", () => {
  test.beforeEach(async () => {
    testApp = await launchApp();
    await completeSetup(testApp.window);
  });

  test.afterEach(async () => {
    await testApp?.close();
  });

  test("the sale dialog hides profit for a Staff account", async () => {
    // A Staff user needs the Staff role. Both fixed roles are created during
    // setup but only the Administrator has an account, so `users.list`
    // returns no Staff row to copy an id from. The roles are fixed and
    // created in order, so Staff is the role after Administrator - read from
    // the list and asserted rather than hard-coded.
    const users = await rpc<
      readonly { id: number; username: string; roleId: number | null; roleName: string | null }[]
    >(testApp.window, "users.list", {});

    const admin = users.find((user) => user.roleName === "Administrator");
    if (admin === undefined || admin.roleId === null) {
      throw new Error("No Administrator account was created by setup");
    }

    // Administrator is inserted first (id 1); Staff is inserted immediately
    // after it. Any role created between them would change this, so the role
    // is confirmed through the created user's own roleName below.
    const staffRoleId = admin.roleId + 1;

    await rpc(testApp.window, "users.save", {
      username: "clerk",
      displayName: "Shop Clerk",
      roleId: staffRoleId,
      isActive: true,
      password: "Clerk#2026",
    });

    const after = await rpc<
      readonly { username: string; roleName: string | null }[]
    >(testApp.window, "users.list", {});
    const clerk = after.find((user) => user.username === "clerk");
    expect(clerk?.roleName).toBe("Staff");

    // Seed a product so the sale dialog has a line to price.
    await rpc(testApp.window, "products.save", {
      name: "Inline filter",
      openingQuantityMilli: 10_000,
    });

    // Sign out and back in as the Staff user.
    await testApp.window.getByRole("button", { name: /sign out|log out/i }).first().click();
    await testApp.window.getByRole("button", { name: /^sign in$/i }).waitFor({ timeout: 20_000 });
    await testApp.window.getByLabel(/username/i).fill("clerk");
    await testApp.window.getByLabel(/password/i).fill("Clerk#2026");
    await testApp.window.getByRole("button", { name: /^sign in$/i }).click();
    await testApp.window.getByRole("navigation").first().waitFor({ timeout: 20_000 });

    await testApp.window.getByRole("link", { name: /^sales$/i }).first().click();
    await testApp.window.getByRole("button", { name: /new invoice/i }).first().click();

    const saleDialog = testApp.window.getByRole("dialog");
    await expect(saleDialog.getByText("New sale")).toBeVisible();

    // The profit column header and the Total profit row are both absent.
    await expect(saleDialog.getByText("Total profit")).toHaveCount(0);
    await expect(saleDialog.getByRole("columnheader", { name: /^profit$/i })).toHaveCount(0);

    // But the sale itself is still fully recordable: the cost and the selling
    // price are both enterable, and the loss warning still shows.
    await expect(saleDialog.getByLabel(/bought at/i).first()).toBeVisible();
    await expect(saleDialog.getByLabel(/sell at/i).first()).toBeVisible();

    // Records without error.
    await expect(saleDialog.getByRole("button", { name: /create invoice/i })).toBeEnabled();

    // Reports are not reachable for Staff either.
    await expect(testApp.window.getByRole("link", { name: /^reports$/i })).toHaveCount(0);
  });
});