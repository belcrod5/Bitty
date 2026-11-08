export function createRunnerLoginMailer({ env = process.env, fetchImpl = fetch } = {}) {
  return async ({ to, subject, text, id }) => {
    const apiKey = env.MJ_APIKEY_PUBLIC || env.MAILJET_API_KEY;
    const apiSecret = env.MJ_APIKEY_PRIVATE || env.MAILJET_API_SECRET;
    const from = env.RUNNER_LOGIN_MAIL_FROM;
    if (!apiKey || !apiSecret || !from) throw new Error("runner_login_mail_unconfigured");
    const response = await fetchImpl("https://api.mailjet.com/v3.1/send", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ Messages: [{ From: { Email: from, Name: "Bitty" }, To: [{ Email: to }], Subject: subject, TextPart: text, CustomID: id }] }),
    });
    if (!response.ok) throw new Error("runner_login_mail_unavailable");
    const result = await response.json();
    if (result.Messages?.length !== 1 || result.Messages[0].Status !== "success") throw new Error("runner_login_mail_unavailable");
  };
}
