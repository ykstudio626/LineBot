// SDK V8用 LineBot
// V9になるとReplyMessageなどの仕様が変わるので注意

import { Client } from "@line/bot-sdk";
import OpenAI from "openai";
import type { CreateChatCompletionRequestMessage } from "openai/resources/chat/completions/completions.js";
import tools from "./tools.js";
import { web_search } from "./functions.js";

const lineClient = new Client({
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN as string
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MEMORY_NUM = 20; // 会話を保持する数

// メンション限定モード: true の場合、以下の候補に含まれる単語がメッセージ内に
// 含まれている場合のみボットが反応します。切り替えはこの定数を true/false で行ってください。
const MENTION_ONLY: boolean = true;

// 反応するメンション候補（ひらがな／カタカナ／英語表記など）
const MENTION_KEYWORDS = [
  "ぼっと",
  "ボット",
  "b",
  "B",
  "bot",
  "ai",
  "Takamaro",
  "たかまろ",
  "タカマロ"
];

// 正規表現用エスケープヘルパー
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// -----------------------------------
// 会話メモリ
// -----------------------------------

// メッセージ型（限定して安全に扱う）
type MessageRecord = {
  role: "system" | "user" | "assistant";
  content: string;
};

const memories: Record<string, MessageRecord[]> = {};

// -----------------------------------
// Webhook
// -----------------------------------

export default async function handler(req: any, res: any): Promise<void> {

  // GET確認用
  if (req.method === "GET") {
    res.status(200).send("HELLO");
    return;
  }

  // POST以外拒否
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {

    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    for (const event of events) {

      // テキストまたは画像以外は無視
      if (event.type !== "message") {
        continue;
      }

      const msgType = event.message?.type;
      if (msgType !== "text" && msgType !== "image") {
        continue;
      }

      // -----------------------------------
      // 発言内容（テキスト or 画像）
      // -----------------------------------

      let userMessage: string = "";
      let imageBuffer: Buffer | null = null;

      if (msgType === "text") {
        userMessage = event.message.text;

        // 「退出」で始まるメッセージはメンション不要で即退出処理
        if (userMessage.startsWith("退出")) {
          const farewell = "ありがとうございました。またご利用お待ちしております！";
          await lineClient.replyMessage(event.replyToken, [{ type: "text", text: farewell }]);
          if (event.source?.groupId) {
            await lineClient.leaveGroup(event.source.groupId);
          } else if (event.source?.roomId) {
            await lineClient.leaveRoom(event.source.roomId);
          }
          continue;
        }

        // メンション限定モードが有効な場合、指定キーワードを含まない発言は無視する。
        if (MENTION_ONLY) {
          const mentionRegex = new RegExp("[@＠](?:" + MENTION_KEYWORDS.map(escapeRegExp).join("|") + ")", "gi");
          if (!mentionRegex.test(userMessage)) {
            // メンションがないためこの発言には反応せずスキップ
            console.log("Skipping non-mention text message:", userMessage);
            continue;
          }

          // メンション単語（@付き）を取り除いてクリーンな本文だけを扱う
          userMessage = userMessage.replace(mentionRegex, "").replace(/\s+/g, " ").trim();
          console.log("Message after removing mention tokens:", userMessage);

          // メンション語を除去した結果、本文が空であれば処理を中断して次イベントへ。
          if (!userMessage) {
            console.log("Message empty after removing mention tokens; skipping.");
            continue;
          }
        }

        // メンション付きリプライの場合、引用元メッセージが画像なら取得して解析対象にする
        if (event.message.quotedMessageId) {
          try {
            const stream = await (lineClient as any).getMessageContent(event.message.quotedMessageId);
            const chunks: Buffer[] = [];
            for await (const chunk of stream as AsyncIterable<Buffer>) {
              chunks.push(Buffer.from(chunk));
            }
            imageBuffer = Buffer.concat(chunks);
            console.log("Retrieved quoted image for analysis");
          } catch (e: any) {
            // 画像以外のメッセージ or コンテンツ期限切れの場合は無視
            console.log("Quoted message is not image or unavailable:", e?.message ?? e);
          }
        }
      } else {
        // 画像メッセージ処理: LINE からコンテンツを取得し Buffer に結合
        try {
          const stream = await (lineClient as any).getMessageContent(event.message.id);
          const chunks: Buffer[] = [];
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            chunks.push(Buffer.from(chunk));
          }
          imageBuffer = Buffer.concat(chunks);
        } catch (e: any) {
          console.error("Failed to download image:", e?.message ?? e);
          continue;
        }

        // メンション限定モードが有効な場合、メッセージのテキスト部分でメンションを確認します。
        // LINE の画像メッセージにテキストが同居していない場合は、メンションが必要なら別途トリガが必要です。
        if (MENTION_ONLY) {
          const captionText = event.message?.text ?? "";
          const mentionRegex = new RegExp("[@＠](?:" + MENTION_KEYWORDS.map(escapeRegExp).join("|") + ")", "gi");
          if (!mentionRegex.test(captionText)) {
            console.log("Skipping non-mention image message");
            continue;
          }
          // メンション語（@付き）を取り除いたキャプションを userMessage として利用
          userMessage = captionText.replace(mentionRegex, "").replace(/\s+/g, " ").trim();
        }
      }

      // -----------------------------------
      // 会話部屋ID
      // -----------------------------------

      const memoryKey: string =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "unknown";

      // -----------------------------------
      // メモリ初期化
      // -----------------------------------

      if (!memories[memoryKey]) {
        memories[memoryKey] = [];
      }

      // -----------------------------------
      // ユーザ発言保存
      // -----------------------------------

      memories[memoryKey].push({
        role: "user",
        content: userMessage
      });

      // -----------------------------------
      // 直近10件だけ保持
      // -----------------------------------

      // 直近n件だけ保持
      memories[memoryKey] =
        memories[memoryKey].slice(-1 * MEMORY_NUM);

      // -----------------------------------
      // OpenAI
      // -----------------------------------

      // メッセージを作成
      // システムプロンプト（役割指定）のほか、現在の時刻（JST）を明示的に
      // モデルに伝えるために日付を追加する。これによりモデルは「現在」が
      // いつかを参照でき、最新性が必要な問い合わせに強くなる。
      const now = new Date();
      // JST（日本時間）に合わせて現在日時を取得
      const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const yyyy = jst.getFullYear();
      const mm = jst.getMonth() + 1;
      const dd = jst.getDate();
      const hh = String(jst.getHours()).padStart(2, "0");
      const min = String(jst.getMinutes()).padStart(2, "0");
      const ss = String(jst.getSeconds()).padStart(2, "0");
      // 曜日を日本語で取得
      const weekdays = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
      const weekday = weekdays[jst.getDay()];
      // 日付と時刻（時分秒）および曜日を含め、明示的に日本時間であることを伝える
      const dateSystemMessage = `現在は${yyyy}年${mm}月${dd}日（${weekday}） ${hh}時${min}分${ss}秒（日本時間）です。`;

      const messages: CreateChatCompletionRequestMessage[] = [
        {
          role: "system",
          content:
            "あなたは親切なAIアシスタントです。日本語で自然に会話してください。あなたは特に名前はありませんが、複数人チャットでは「ぼっと、ボット、AI、たかまろ、Takamaro」などでメンションされた場合に反応するようプログラムされています。"
        },
        {
          role: "system",
          content: dateSystemMessage
        },
        ...memories[memoryKey].map((m) => ({
          role: m.role,
          content: m.content
        }))
      ];

      let finalReply: string;

      if (imageBuffer) {
        // -----------------------------------
        // 画像パス: Vision API を直接使用
        // -----------------------------------
        console.log("[image] size:", imageBuffer.byteLength, "bytes");
        const b64 = imageBuffer.toString("base64");
        const visionResp = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content: "あなたは親切なAIアシスタントです。日本語で回答してください。"
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: userMessage || "この画像について教えてください。"
                },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${b64}` }
                }
              ] as any
            }
          ]
        });
        finalReply = (visionResp.choices?.[0]?.message?.content as string) ?? "";
        console.log("[image] reply:", finalReply.slice(0, 100));

      } else {
        // -----------------------------------
        // テキストパス: function calling
        // -----------------------------------
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages,
          functions: tools.map(t => t.function)
        });

        const message = completion.choices?.[0]?.message;
        const aiText: string = (message?.content as string) ?? "";

        // tool_calls（新）または function_call（旧）に対応
        const rawToolCalls = message?.tool_calls ?? (message?.function_call ? [message.function_call] : undefined);

        finalReply = aiText;

        if (rawToolCalls && rawToolCalls.length > 0) {
          for (const call of rawToolCalls) {
            const func = (((call as any).function) ?? (call as any)) as any;
            const name = String(func?.name ?? "");
            const argsRaw = func?.arguments ?? func?.args ?? "";

            console.log("name:", name);
            console.log("argsRaw:", argsRaw);

            const args: any = typeof argsRaw === "string" && argsRaw ? JSON.parse(argsRaw) : (argsRaw ?? {});

            let toolResult: any;

            if (name === "web_search") {
              let query = args.query ?? "";

              try {
                const genericRe = /最新|最近|ニュース/;
                const datePresentRe = /\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}/;

                if (genericRe.test(query) && !datePresentRe.test(query)) {
                  const now = new Date();
                  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
                  const y = jst.getFullYear();
                  const m = jst.getMonth() + 1;
                  const d = jst.getDate();
                  const dateStr = `${y}年${m}月${d}日`;
                  const cleaned = query.replace(/最新の|最近の|最新|最近/g, "").trim();

                  if (!cleaned || cleaned === "ニュース") {
                    query = `${dateStr}の最新のニュース`;
                  } else {
                    query = `${dateStr}の最新の${cleaned}`;
                  }

                  console.log("Normalized web_search query:", query);
                }

                toolResult = await web_search(query);
              } catch (e: any) {
                toolResult = `web_search error: ${e?.message ?? String(e)}`;
              }
            } else {
              toolResult = `No implementation for tool: ${name}`;
            }

            console.log("toolResult", toolResult);

            const funcPrompt =
              "あなたは親切なAIアシスタントです。直前に与えられた関数の出力を参考にして、ユーザーの質問に対する最終回答を日本語で簡潔に作成してください。\n不確かな点は「不明です」と明示してください。出典URLがある場合はリンクとともに必ず明記してください。";

            const followupMessages = [
              ...messages,
              { role: "system", content: funcPrompt } as any,
              {
                role: "function",
                name,
                content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult)
              } as any
            ];

            const followup = await openai.chat.completions.create({
              model: "gpt-4.1-mini",
              messages: followupMessages
            });

            finalReply = (followup.choices?.[0]?.message?.content as string) ?? finalReply;

            console.log("finalReply", finalReply);
          }
        }
      }

      // AI返答保存（最終）
      memories[memoryKey].push({
        role: "assistant",
        content: finalReply
      });

      // LINE返信（最終）
      await lineClient.replyMessage(event.replyToken, [
        {
          type: "text",
          text: finalReply
        }
      ]);
    }

    res.status(200).send("OK");

  } catch (err) {

    console.error(err);

    res.status(500).send("ERROR");
  }
}
