import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
const root=process.cwd();
const edgePath=[process.env.EDGE_PATH,process.env.CHROME_PATH].find(p=>p&&existsSync(p));
test('Ask streaming, composer layout, and original PDF download work in the browser', {skip:!edgePath,timeout:40000}, async()=>{
  const server=createServer((req,res)=>{
    const route=new URL(req.url,'http://local').pathname;
    if(route==='/api/startup'){res.writeHead(200,{'content-type':'application/json'});res.end('{"hasFile":false}');return;}
    if(route==='/sample.pdf'){res.writeHead(200,{'content-type':'application/pdf'});res.end(readFileSync(path.join(root,'samples/demo.pdf')));return;}
    const file=path.resolve(root,'web','.'+(route==='/'?'/index.html':route));
    if(!file.startsWith(path.join(root,'web')+path.sep)){res.writeHead(403);res.end();return;}
    try {const data=readFileSync(file);res.writeHead(200,{'content-type':file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(data);}catch{res.writeHead(404);res.end();}
  });
  const profile = mkdtempSync(path.join(tmpdir(), "fpv-toolbar-edge-"));
  let edge;
  let socket;

  const waitFor = async (predicate, description, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for " + description);
  };

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverPort = server.address().port;
    edge = spawn(edgePath, [
      "--headless=new",
      // Headless Chrome in a restricted/CI sandbox cannot initialize its own
      // renderer sandbox; without these two the browser accepts the WebSocket
      // but never answers a single page-domain command, so every step just
      // times out instead of failing loudly.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--user-data-dir=" + profile,
      "about:blank",
    ], { stdio: "ignore", windowsHide: true });

    const activePortFile = path.join(profile, "DevToolsActivePort");
    const debuggingPort = await waitFor(() => {
      try {
        const portValue = Number(readFileSync(activePortFile, "utf8").split(/\r?\n/)[0]);
        return Number.isFinite(portValue) && portValue > 0 ? portValue : null;
      } catch {
        return null;
      }
    }, "Edge remote debugging");
    const targets = await (await fetch("http://127.0.0.1:" + debuggingPort + "/json/list")).json();
    const page = targets.find(target => target.type === "page");
    assert.ok(page, "Edge opened a page target");

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", async event => {
      const raw = event.data instanceof Blob ? await event.data.text() : String(event.data);
      const message = JSON.parse(raw);
      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + " timed out"));
      }, 5000);
      pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
      }
      return result.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument',{source:
      "globalThis.__PDF_BENCH__=true;localStorage.setItem('fast-pdf-viewer-settings',JSON.stringify({apiKey:'browser-test',apiBaseUrl:'https://mock.invalid/v1',model:'mock',showThinking:true,uiLanguage:'zh-CN',uiLanguageSelected:true}));"});
    await send('Page.navigate',{url:'http://127.0.0.1:'+serverPort+'/'});
    await waitFor(()=>evaluate('!!globalThis.__pdfViewer'),'main app');
    await evaluate(String.raw`(()=>{
      const viewer=globalThis.__pdfViewer;
      viewer.pdf={};viewer.pageCount=200;viewer.indexedPages=200;viewer.indexPromise=Promise.resolve();
      viewer.pageTexts=[{pageNumber:1,text:'x'.repeat(25000)},{pageNumber:200,text:'ARC means Anti-Reflective Coating.'}];
      viewer.showHits=async(hits,query,index)=>{window.__citationTarget=hits[index];};
      const original=window.fetch;let calls=0;
      window.fetch=async(url,init)=>{
        if(!String(url).startsWith('https://mock.invalid'))return original(url,init);
        calls++;const body=JSON.parse(init.body);
        if(calls===1)return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,reasoning_content:'First inspect the document.',tool_calls:[{id:'search1',type:'function',function:{name:'search_document',arguments:JSON.stringify({query:'ARC'})}}]}}]}),{headers:{'content-type':'application/json'}});
        const encoder=new TextEncoder();let index=0;const parts=['Now read the ARC evidence.','\nThe coating is on page 200.','\nVerify the exact quotation.'];
        return new Response(new ReadableStream({async start(controller){
          for(const part of parts){await new Promise(r=>setTimeout(r,350));controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:part}}]})+'\n\n'));}
          await new Promise(r=>setTimeout(r,350));
          controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:'**ARC** is on [p200](pdf:200). Ignore [p999](pdf:999).' + '\n\nAdditional document evidence stays readable above the composer.'.repeat(18) + '\n---\np200: "ARC means Anti-Reflective Coating."'},finish_reason:'stop'}]})+'\n\n'));controller.close();
        }}),{headers:{'content-type':'text/event-stream'}});
      };
      document.getElementById('btn-ask-toggle').click();document.getElementById('ask-input').value='Where is ARC described?';document.getElementById('ask-input').dispatchEvent(new Event('input'));document.getElementById('ask-submit').click();
    })()`);
    await waitFor(()=>evaluate("document.getElementById('ask-thinking-preview').textContent.includes('Now read')"),'collapsed streaming preview');
    assert.equal(await evaluate("document.getElementById('ask-thinking-wrap').open"),false);
    await evaluate("document.querySelector('#ask-thinking-wrap summary').click()");
    await waitFor(()=>evaluate("document.getElementById('ask-thinking').textContent.includes('Verify the exact')"),'expanded live text');
    assert.equal(await evaluate("document.getElementById('ask-thinking-wrap').open"),true);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('ask-thinking-preview')).display"),'none');
    await waitFor(()=>evaluate("document.getElementById('ask-stop').hidden"),'answer completion');
    const result=await evaluate(`({answer:document.getElementById('ask-answer').textContent,bold:!!document.querySelector('#ask-answer strong'),log:document.getElementById('ask-reading-log').textContent,thinking:document.getElementById('ask-thinking').textContent,status:document.getElementById('ask-thinking-status').textContent})`);
    assert.match(result.answer,/ARC/);assert.equal(result.bold,true);assert.match(result.log,/ARC/);assert.match(result.log,/1/);assert.match(result.thinking,/First inspect/);assert.match(result.thinking,/Verify/);assert.match(result.status,/已完成/);
    assert.equal(await evaluate("document.querySelector('[data-i18n=askAnswer]').textContent"),'回答');
    assert.equal(await evaluate("document.querySelector('#ask-citations-wrap')"),null);
    assert.equal(await evaluate("document.querySelectorAll('#ask-answer .ask-page-reference').length"),1);
    await evaluate("document.querySelector('#ask-answer .ask-page-reference').click()");
    await waitFor(()=>evaluate("window.__citationTarget?.pageNumber===200"),'inline reference viewer jump');
    assert.equal(await evaluate("window.__citationTarget.kind"),'quote');
    assert.equal(await evaluate("document.querySelector('#ask-citations-wrap')"),null);
    await evaluate("document.querySelector('#ask-thinking-wrap summary').click()");
    assert.match(await evaluate("document.getElementById('ask-thinking-preview').textContent"),/Verify/);
    await evaluate("document.getElementById('ask-thread').scrollTop=document.getElementById('ask-thread').scrollHeight");
    const layout=await evaluate("({gap:document.getElementById('ask-thread').getBoundingClientRect().bottom-document.querySelector('.ask-turn-actions').getBoundingClientRect().bottom,button:document.querySelector('.ask-copy').getBoundingClientRect().width,icon:document.querySelector('.ask-copy .icon').getBoundingClientRect().width})");
    assert.ok(layout.gap >= 39, 'answer actions leave space above the composer: ' + JSON.stringify(layout));
    assert.equal(layout.button,24);
    assert.equal(layout.icon,14);
    await evaluate(`(async () => {
      const input = document.getElementById('ask-input');
      input.value = Array.from({length: 18}, () => 'Long question text uses the full width of the composer.').join('\\n');
      input.dispatchEvent(new Event('input'));
      // Resizing the composer queues a thread scroll that closes popovers.
      // Let that layout settle before simulating the next user click.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.getElementById('btn-ask-more').click();
    })()`);
    const menuLayout=await evaluate(`(() => {
      const button = document.getElementById('btn-ask-more');
      const rect = button.getBoundingClientRect();
      const menu = document.getElementById('ask-more-menu');
      return { parent: button.closest('.ask-compose-actions') !== null,
        open: !menu.hidden, bottom: menu.getBoundingClientRect().bottom, top: rect.top,
        inputHeight: document.getElementById('ask-input').getBoundingClientRect().height };
    })()`);
    assert.equal(menuLayout.parent,true);
    assert.equal(menuLayout.open,true);
    assert.ok(menuLayout.bottom <= menuLayout.top - 5, 'composer menu opens above its button');
    assert.equal(menuLayout.inputHeight,160);
    await evaluate("document.getElementById('btn-ask-more').click()");
    if(process.env.ASK_PREVIEW_PATH){
      mkdirSync(path.dirname(process.env.ASK_PREVIEW_PATH),{recursive:true});
      const screenshot=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(process.env.ASK_PREVIEW_PATH,Buffer.from(screenshot.data,'base64'));
      await evaluate("document.querySelector('#ask-thinking-wrap summary').click()");
      const expanded=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(process.env.ASK_PREVIEW_PATH.replace('.png','-expanded.png'),Buffer.from(expanded.data,'base64'));
    }
    // Exercise a real browser download after opening an actual local PDF.
    const downloadPath=path.join(profile,'downloads');
    mkdirSync(downloadPath,{recursive:true});
    await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath});
    await evaluate("document.getElementById('btn-sidebar-close').click()");
    await evaluate(`(() => {
      const viewer = globalThis.__pdfViewer;
      const open = viewer.open.bind(viewer);
      viewer.open = async (source, options) => {
        window.__reportLoading = options.onProgress;
        options.onProgress({loaded: 5 * 1024 ** 2, total: 20 * 1024 ** 2});
        await new Promise(resolve => { window.__releaseLoading = resolve; });
        return open(source, options);
      };
    })()`);
    await evaluate(`(async () => {
      const data = await (await fetch('/sample.pdf')).arrayBuffer();
      const files = new DataTransfer();
      files.items.add(new File([data], 'browser-local-copy.pdf', {type: 'application/pdf'}));
      document.getElementById('viewer-wrap').dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: files}));
    })()`);
    await waitFor(()=>evaluate("document.getElementById('viewer-loading-track').getAttribute('aria-valuenow') === '25'"),'byte loading progress');
    assert.equal(await evaluate("document.getElementById('viewer-loading').hidden"),false);
    assert.match(await evaluate("document.getElementById('viewer-loading-detail').textContent"),/5 MB.*20 MB.*25%/);
    const progressWidth=await waitFor(()=>evaluate("document.getElementById('viewer-loading-fill').getBoundingClientRect().width > 50 && document.getElementById('viewer-loading-fill').getBoundingClientRect().width"),'visible progress fill');
    assert.ok(progressWidth > 50 && progressWidth <= 71);
    if(process.env.LOADING_PREVIEW_PATH){
      mkdirSync(path.dirname(process.env.LOADING_PREVIEW_PATH),{recursive:true});
      const screenshot=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(process.env.LOADING_PREVIEW_PATH,Buffer.from(screenshot.data,'base64'));
    }
    await evaluate("window.__reportLoading({phase:'prepare'})");
    assert.equal(await evaluate("document.getElementById('viewer-loading-track').getAttribute('aria-valuenow')"),null);
    assert.match(await evaluate("document.getElementById('viewer-loading-detail').textContent"),/正在准备页面/);
    await evaluate("window.__releaseLoading()");
    await waitFor(()=>evaluate("!document.getElementById('btn-save-pdf').hidden && !document.getElementById('btn-save-pdf').disabled"),'local PDF export ready');
    assert.equal(await evaluate("document.getElementById('viewer-loading').hidden"),true);
    assert.equal(await evaluate("document.getElementById('pdf-save-icon').getAttribute('href')"),'#i-save');
    await evaluate("document.getElementById('btn-save-pdf').click()");
    const downloaded=path.join(downloadPath,'browser-local-copy.pdf');
    await waitFor(()=>existsSync(downloaded),'original PDF download');
    assert.deepEqual(readFileSync(downloaded),readFileSync(path.join(root,'samples/demo.pdf')));
  } finally {
    socket?.close();edge?.kill();
    await new Promise(resolve=>server.close(resolve));
    try{rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch{}
  }
});
