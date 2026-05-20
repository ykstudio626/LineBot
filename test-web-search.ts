(async () => {
  try {
    const mod = await import("./api/functions.ts");
    const web_search = mod.web_search;
    const q = process.argv[2] ?? "最新のテックニュース";
    const res = await web_search(q);
    console.log(res);
  } catch (e) {
    console.error("error:", e);
  }
})();