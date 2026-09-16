(() => {
  "use strict";

  const form = document.querySelector("#login-form");
  const usernameInput = document.querySelector("#username");
  const passwordInput = document.querySelector("#password");
  const rememberInput = document.querySelector("#remember-username");
  const toggleButton = document.querySelector("#toggle-password");
  const submitButton = document.querySelector("#login-submit");
  const submitLabel = submitButton.querySelector(".submit-label");
  const message = document.querySelector("#login-message");
  const params = new URLSearchParams(window.location.search);

  function safeDestination() {
    const next = params.get("next");
    if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) {
      return "/";
    }
    return next;
  }

  function showMessage(text, tone = "error") {
    message.textContent = text;
    message.dataset.tone = tone;
    message.hidden = false;
  }

  function clearMessage() {
    message.hidden = true;
    message.textContent = "";
    delete message.dataset.tone;
  }

  function setLoading(loading) {
    submitButton.disabled = loading;
    submitButton.classList.toggle("is-loading", loading);
    submitLabel.textContent = loading ? "正在验证…" : "登录并开始核对";
  }

  const rememberedUsername = window.localStorage.getItem("newmore_username");
  if (rememberedUsername) {
    usernameInput.value = rememberedUsername;
    rememberInput.checked = true;
    passwordInput.focus();
  }

  if (params.get("loggedOut") === "1") {
    showMessage("已安全退出，请重新登录。", "success");
  } else {
    fetch("/api/session", { credentials: "same-origin", cache: "no-store" })
      .then((response) => {
        if (response.ok) window.location.replace(safeDestination());
      })
      .catch(() => undefined);
  }

  toggleButton.addEventListener("click", () => {
    const showing = passwordInput.type === "text";
    passwordInput.type = showing ? "password" : "text";
    toggleButton.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
    toggleButton.setAttribute("aria-pressed", String(!showing));
    passwordInput.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessage();
    if (!form.reportValidity()) return;

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    setLoading(true);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("用户名或密码错误，请重新输入。");
        if (response.status === 429) throw new Error("尝试次数过多，请稍后再试。");
        throw new Error("登录服务暂时不可用，请稍后再试。");
      }

      if (rememberInput.checked) window.localStorage.setItem("newmore_username", username);
      else window.localStorage.removeItem("newmore_username");

      passwordInput.value = "";
      window.location.replace(safeDestination());
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "登录失败，请稍后再试。");
      passwordInput.select();
      setLoading(false);
    }
  });
})();
