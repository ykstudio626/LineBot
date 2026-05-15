// SDK V8用 LineBot
// V9になるとReplyMessageなどの仕様が変わるので注意

import { Client } from "@line/bot-sdk";
import OpenAI from "openai";

const lineClient = new Client({
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN as string
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MEMORY_NUM = 10; // 会話を保持する数

// -----------------------------------
// 会話メモリ
// -----------------------------------

type MessageRecord = { role: string; content: string };

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

      // テキスト以外無視
      if (
        event.type !== "message" ||
        event.message?.type !== "text"
      ) {
        continue;
      }

      // -----------------------------------
      // 発言内容
      // -----------------------------------

      const userMessage: string = event.message.text;

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

      const completion = (await openai.chat.completions.create({

        model: "gpt-4.1-mini",

        messages: [

          {
            role: "system",
            content:
              "あなたは親切なAIアシスタントです。" +
              "日本語で自然に会話してください。"
          },

          ...(memories[memoryKey] as any)
        ]
      })) as any;

      const aiText: string =
        (completion.choices?.[0]?.message?.content as string) ?? "";

      // -----------------------------------
      // AI返答保存
      // -----------------------------------

      memories[memoryKey].push({
        role: "assistant",
        content: aiText
      });

      // -----------------------------------
      // LINE返信
      // -----------------------------------

      await lineClient.replyMessage(
        event.replyToken,
        [
          {
            type: "text",
            text: aiText
          }
        ]
      );
    }

    res.status(200).send("OK");

  } catch (err) {

    console.error(err);

    res.status(500).send("ERROR");
  }
}
