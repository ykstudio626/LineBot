// SDK V8用 LineBot
// V9になるとReplyMessageなどの仕様が変わるので注意

import { Client } from "@line/bot-sdk";
import OpenAI from "openai";

const MEMORY_NUM = 10; // 会話を保持する数

const lineClient = new Client({
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


// -----------------------------------
// 会話メモリ
// -----------------------------------

const memories = {}; // ここに保持した会話がn件入ってくる


// -----------------------------------
// Webhook
// -----------------------------------

export default async function handler(
  req,
  res
) {

  // GET確認用
  if (req.method === "GET") {
    return res.status(200).send("HELLO");
  }

  // POST以外拒否
  if (req.method !== "POST") {
    return res
      .status(405)
      .send("Method Not Allowed");
  }

  try {

    const events = req.body.events;

    for (const event of events) {

      // テキスト以外無視
      if (
        event.type !== "message" ||
        event.message.type !== "text"
      ) {
        continue;
      }

      // -----------------------------------
      // 発言内容
      // -----------------------------------

      const userMessage =
        event.message.text;

      // -----------------------------------
      // 会話部屋ID
      // -----------------------------------

      const memoryKey =
        event.source.groupId ||
        event.source.roomId ||
        event.source.userId;

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
      // 直近n件だけ保持
      // -----------------------------------

      memories[memoryKey] =
        memories[memoryKey].slice(-1 * MEMORY_NUM);

      // -----------------------------------
      // OpenAI
      // -----------------------------------

      const completion =
        await openai.chat.completions.create({

          model: "gpt-4.1-mini",

          messages: [

            {
              role: "system",
              content:
                "あなたは親切なAIアシスタントです。" +
                "日本語で自然に会話してください。"
            },

            ...memories[memoryKey]
          ]
        });

      const aiText =
        completion.choices[0]
          .message.content;

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

    return res.status(200).send("OK");

  } catch (err) {

    console.error(err);

    return res.status(500).send("ERROR");
  }
}