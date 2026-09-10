const LANG_NAME = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  en: "English",
  ja: "日本語",
};

export async function translateText(text, settings) {
  if (!settings.apiKey) {
    throw new Error("还没有填写 OpenRouter API Key，请先打开设置。");
  }
  const language = LANG_NAME[settings.targetLang] || settings.targetLang;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": location.origin,
      "X-Title": "速览 Fast PDF Viewer",
    },
    body: JSON.stringify({
      model: settings.model || "openai/gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `You are a precise translator. Translate the user's text into ${language}. Preserve numbers, names, and line breaks. Return only the translation.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenRouter 请求失败 (${response.status})`;
    throw new Error(message);
  }
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("模型没有返回译文。");
  return content;
}
