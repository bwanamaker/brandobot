/* global document, window, localStorage, navigator */
(() => {
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
  let preference
  try {
    const saved = localStorage.getItem("brandobot-theme")
    if (saved === "light" || saved === "dark") preference = saved
  } catch { /* System theme still works when storage is unavailable. */ }

  function applyTheme() {
    const theme = preference ?? (systemTheme.matches ? "dark" : "light")
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#191a1c" : "#f6f5f2"
    document.querySelector(".theme-toggle")?.setAttribute("aria-pressed", String(theme === "dark"))
  }

  applyTheme()
  systemTheme.addEventListener("change", applyTheme)

  document.addEventListener("DOMContentLoaded", () => {
    const themeButton = document.querySelector(".theme-toggle")
    themeButton.hidden = false
    applyTheme()
    themeButton.addEventListener("click", () => {
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark"
      try { localStorage.setItem("brandobot-theme", preference) } catch { /* Keep the choice for this page. */ }
      applyTheme()
    })

    const copyButton = document.querySelector(".copy-button")
    const code = document.querySelector("#install-code")
    const status = document.querySelector(".copy-status")
    copyButton.hidden = false
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent)
        status.textContent = "Copied! Add this to your OpenCode configuration."
      } catch {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(code)
        selection.removeAllRanges()
        selection.addRange(range)
        code.parentElement.focus()
        status.textContent = "Select and copy the highlighted configuration with your browser’s Copy command."
      }
    })
  })
})()
