import { expect, test } from "@playwright/test";

test.describe("react-mind smoke", () => {
  test("shows auth gate before sign-in", async ({ page }) => {
    await page.goto("/");

    const authCard = page.locator(".auth-state-card");
    await expect(authCard.getByRole("heading", { name: "Sign in required" })).toBeVisible();
    await expect(authCard.getByRole("button", { name: "Sign In Google" })).toBeVisible();
    await expect(authCard.getByText("Please sign in with Google to load graph stores and open the canvas.")).toBeVisible();
  });

  test("menu opens one at a time", async ({ page }) => {
    await page.goto("/");

    const fileMenu = page.locator("details.menu-item").filter({ has: page.getByText("File") });
    const editMenu = page.locator("details.menu-item").filter({ has: page.getByText("Edit") });

    await fileMenu.locator("summary").click();
    await expect(fileMenu).toHaveAttribute("open", "");

    await editMenu.locator("summary").click();
    await expect(editMenu).toHaveAttribute("open", "");
    await expect(fileMenu).not.toHaveAttribute("open", "");
  });

  test("clicking outside closes menus", async ({ page }) => {
    await page.goto("/");

    const fileMenu = page.locator("details.menu-item").filter({ has: page.getByText("File") });
    await fileMenu.locator("summary").click();
    await expect(fileMenu).toHaveAttribute("open", "");

    await page.getByRole("heading", { name: "Sign in required" }).click();
    await expect(fileMenu).not.toHaveAttribute("open", "");
  });
});
