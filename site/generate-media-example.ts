import { join } from "node:path";
import { openTestBrowser } from "../scripts/browser.ts";

// Generate fictional campaign assets, then record them in the real media UI.
// Supply Chromium and ffmpeg explicitly; this never installs dependencies.
const assets = join(import.meta.dir, "assets");
const encoder = process.env.R3_TEST_FFMPEG ?? "ffmpeg";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/font.ttf"
      ? new Response(Bun.file(join(assets, "fonts/Roboto.ttf")))
      : new Response("<!doctype html><canvas width='960' height='540'></canvas>", {
          headers: { "Content-Type": "text/html" },
        }),
});
const browser = await openTestBrowser();
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.navigate", { url: server.url.href });
  await page.evaluate(`(async () => {
    const font = new FontFace('Campaign', 'url(/font.ttf)', {weight:'100 900'});
    document.fonts.add(await font.load());
  })()`);
  for (const version of [1, 2]) {
    const png = await page.evaluate(`(() => {
      const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f5eddf'; ctx.fillRect(0, 0, 960, 540);
      ctx.fillStyle = '#e7a16e'; ctx.beginPath(); ctx.arc(866, 170, 248, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#f5eddf'; ctx.lineWidth = 2;
      for (const radius of [95, 145, 195]) { ctx.beginPath(); ctx.arc(866, 170, radius, 0, Math.PI*2); ctx.stroke(); }
      ctx.save(); ctx.translate(680, 250); ctx.rotate(-0.12);
      ctx.fillStyle = '#31594d'; ctx.fillRect(0, 0, 190, 190);
      ctx.fillStyle = '#d6dfae'; ctx.fillRect(16, 16, 158, 64);
      ctx.fillStyle = '#f5eddf'; ctx.fillRect(16, 100, 108, 5); ctx.fillRect(16, 116, 145, 5); ctx.fillRect(16, 132, 130, 5);
      ctx.restore();
      ctx.fillStyle = '#31594d'; ctx.font = '700 24px Campaign'; ctx.fillText('fieldwork', 64, 66);
      ctx.font = '500 58px Campaign'; ctx.fillText('Make space for', 64, 188); ctx.fillText('your next idea.', 64, 258);
      ctx.font = '400 20px Campaign'; ctx.fillText('A calmer place to plan your work.', 67, 310);
      if (${version} === 2) { ctx.fillStyle = '#31594d'; ctx.fillRect(64, 416, 410, 62); }
      ctx.fillStyle = ${version} === 2 ? '#ffffff' : '#b0a18e';
      ctx.font = '500 26px Campaign'; ctx.fillText('Launching October 28', 82, 456);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    const image = join(assets, `fieldwork-launch-v${version}.png`);
    const video = join(assets, `fieldwork-launch-v${version}.webm`);
    await Bun.write(image, Buffer.from(png, "base64"));
    const duration = version === 1 ? 6 : 8;
    const encode = Bun.spawn(
      [
        encoder,
        "-y",
        "-v",
        "error",
        "-loop",
        "1",
        "-i",
        image,
        "-t",
        String(duration),
        "-r",
        "12",
        "-vf",
        `fade=t=out:st=${duration - 1}:d=1`,
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "32",
        "-b:v",
        "0",
        video,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    if (await encode.exited) throw new Error("Campaign video generation failed");
    const frame = Bun.spawn(
      [
        encoder,
        "-y",
        "-v",
        "error",
        "-ss",
        "2",
        "-i",
        video,
        "-frames:v",
        "1",
        join(assets, `fieldwork-launch-frame-v${version}.png`),
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    if (await frame.exited) throw new Error("Campaign frame capture failed");
    console.log(`Generated launch image, video, and frame for v${version}`);
  }
} finally {
  await browser.close();
  server.stop(true);
}
