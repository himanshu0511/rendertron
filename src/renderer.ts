import * as puppeteer from 'puppeteer';
import * as fse from'fs-extra';
import * as url from 'url';
import {BrowserPool} from './browserPool';
import {Browser, Request, RespondOptions} from 'puppeteer';

type SerializedResponse = {
  status: number; content: string;
};

type ViewportDimensions = {
  width: number; height: number;
};
const MOBILE_USERAGENT =
    'Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.75 Mobile Safari/537.36';

/**
 * Wraps Puppeteer's interface to Headless Chrome to expose high level rendering
 * APIs that are able to handle web components and PWAs.
 */
export class Renderer {
  private readonly browserPool: BrowserPool;
  private responseCache: Record<string, RespondOptions> = {};
  private responseCacheSize: number = 0;
  private static readonly CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 1 day cache
  private static readonly ALLOWED_URL_PATTERN = /^https?:\/\/(.*?).?gozefo.com.*/;
  private static readonly CACHE_URL_PATTERN = /^https?:\/\/(img[0-9]{0,2}).?gozefo.com.*/;
  private responseCacheStartTimeStamp = (new Date()).getTime();
  private blankJPG!: Buffer;
  private blankPNG!: Buffer;
  private blankGIF!: Buffer;
  private blankSVG!: Buffer;

  constructor() {
    this.browserPool = new BrowserPool();
  }
  async initialize() {
    this.blankGIF = await fse.readFile(`${__dirname}/../resources/blank.gif`);
    this.blankPNG = await fse.readFile(`${__dirname}/../resources/blank.png`);
    this.blankJPG = await fse.readFile(`${__dirname}/../resources/blank.jpg`);
    this.blankSVG = await fse.readFile(`${__dirname}/../resources/blank.svg`);
  }

  async serialize(requestUrl: string, isMobile: boolean):
      Promise<SerializedResponse> {
    /**
     * Executed on the page after the page has loaded. Strips script and
     * import tags to prevent further loading of resources.
     */
    function stripPage() {
      // Strip only script tags that contain JavaScript (either no type attribute or one that contains "javascript")
      const elements = document.querySelectorAll('script:not([type]), script[type*="javascript"], link[rel=import]');
      for (const e of Array.from(elements)) {
        e.remove();
      }
    }

    function modifyCSSStyleSheetPrototype() {
        // const head = document.getElementsByTagName('head')[0];
        // const script = document.createElement('script');
        // script.type = 'text/javascript';
        // script.innerHTML = 'const prototypeInsertRule = window.CSSStyleSheet.prototype.insertRule;/* @ts-ignore*/window.CSSStyleSheet.prototype.insertRule = function(){console.log(\'running\');/* @ts-ignore*/if (!this.styleRules) {/* @ts-ignore*/this.styleRules = [(Array.from(arguments))];} else {/* @ts-ignore*/this.styleRules.push(Array.from(arguments));}prototypeInsertRule.apply(this, Array.from(arguments));};';
        // head.appendChild(script);

        // @ts-ignore
        // window.prototypeInsertRule = window.CSSStyleSheet.prototype.insertRule;
        window.customCSSStyleSheetPrototypeFunctionMap = {};
        // @ts-ignore
        const keyDescriptionMap = Object.getOwnPropertyDescriptors(window.CSSStyleSheet.prototype);
        // @ts-ignore
        Object.getOwnPropertyNames(window.CSSStyleSheet.prototype).forEach((key) => {
            // @ts-ignore
            if (keyDescriptionMap[key].writable &&  typeof window.CSSStyleSheet.prototype[key] === 'function'){
                // @ts-ignore
                window.customCSSStyleSheetPrototypeFunctionMap[key] = window.CSSStyleSheet.prototype[key];
                // @ts-ignore
                window.CSSStyleSheet.prototype[key] = function() {
                    const args = Array.from(arguments);
                    const callLog = args.concat(key);
                    if(this.functionCallLogs) {
                        this.functionCallLogs.push(callLog);
                    } else {
                        this.functionCallLogs = [callLog];
                    }
                    // @ts-ignore
                    return window.customCSSStyleSheetPrototypeFunctionMap[key].apply(this, args);
                };
            }
        });
        // @ts-ignore
        // window.CSSStyleSheet.prototype.insertRule = function() {
        //     console.log('running');
        //     /* @ts-ignore*/
        //     if (!this.styleRules) {
        //         // @ts-ignore
        //         this.styleRules = [(Array.from(arguments))];
        //     } else {
        //         // @ts-ignore
        //         this.styleRules.push(Array.from(arguments));
        //     }
        //     // @ts-ignore
        //     return window.prototypeInsertRule.apply(this, Array.from(arguments));
        // };
    }

    /**
     * Injects a <base> tag which allows other resources to load. This
     * has no effect on serialised output, but allows it to verify render
     * quality.
     */
    function injectBaseHref(origin: string) {
      const base = document.createElement('base');
      base.setAttribute('href', origin);

      const bases = document.head.querySelectorAll('base');
      if (bases.length) {
        // Patch existing <base> if it is relative.
        const existingBase = bases[0].getAttribute('href') || '';
        if (existingBase.startsWith('/')) {
          bases[0].setAttribute('href', origin + existingBase);
        }
      } else {
        // Only inject <base> if it doesn't already exist.
        document.head.insertAdjacentElement('afterbegin', base);
      }
    }

    return await this.browserPool.acquire(async (browser: Browser) => {
      const newIncognitoBrowserContext = await browser.createIncognitoBrowserContext();
      const page = await newIncognitoBrowserContext.newPage();
      await page.setRequestInterception(true);
      await page.evaluateOnNewDocument(modifyCSSStyleSheetPrototype);
      // @ts-ignore
      //   const CSSStyleSheetPrototype = await page.evaluateHandle(() => window.CSSStyleSheet.prototype);//     const insertRule = window.CSSStyleSheet.prototype.insertRule;
      //       // @ts-ignore
      //   const insertRule = CSSStyleSheetPrototype.insertRule;
      //   // @ts-ignore
      //   console.log('runningbefore: ', typeof insertRule);
      //   CSSStyleSheetPrototype.('insertRule = function(){
      //           console.log('running');
      //           // @ts-ignore
      //           if (!this.styleRules) {
      //               // @ts-ignore
      //               this.styleRules = [(Array.from(arguments))];
      //           } else {
      //               // @ts-ignore
      //               this.styleRules.push(Array.from(arguments));
      //           }
      //           insertRule.apply(this, Array.from(arguments));
      //       };
      // await page.evaluate(function(){
          // @ts-ignore
          // const insertRule = window.CSSStyleSheet.prototype.insertRule;/* @ts-ignore*/window.CSSStyleSheet.prototype.insertRule = function(){debugger;console.log('running');/* @ts-ignore*/if (!this.styleRules) {/* @ts-ignore*/this.styleRules = [(Array.from(arguments))];} else {/* @ts-ignore*/this.styleRules.push(Array.from(arguments));}insertRule.apply(this, Array.from(arguments));};

      // });
      page.on('request', (interceptedRequest: Request) => {
        const interceptedUrl = interceptedRequest.url().split('?')[0];
        // console.log('interceptedUrl: ', interceptedUrl, 'allowed: ', interceptedUrl.match(allowedUrlsRegex) ? 'true' : false);
        // if (!interceptedUrl.match(/.*\.(jpg|png|gif|jpeg)$/)){
        if (interceptedUrl.endsWith('.jpg') || interceptedUrl.endsWith('.jpeg')) {
          interceptedRequest.respond({
            contentType: 'image/jpeg',
            body: this.blankJPG,
          });
        } else if (interceptedUrl.endsWith('.gif')) {
          interceptedRequest.respond({
            contentType: 'image/gif',
            body: this.blankGIF,
          });
        }  else if (interceptedUrl.endsWith('.png')) {
          interceptedRequest.respond({
            contentType: 'image/png',
            body: this.blankPNG,
          });
        } else if (interceptedUrl.endsWith('.svg')) {
          interceptedRequest.respond({
            contentType: 'image/png',
            body: this.blankSVG,
          });
        } else if (!interceptedUrl.match(Renderer.ALLOWED_URL_PATTERN))
          interceptedRequest.abort();
        else if (interceptedUrl.match(Renderer.CACHE_URL_PATTERN)) {
          if (this.responseCacheSize > 2000 || ((new Date()).getTime() - this.responseCacheStartTimeStamp) > Renderer.CACHE_EXPIRY) {
            this.responseCache = {};
            this.responseCacheSize = 0;
            this.responseCacheStartTimeStamp = (new Date()).getTime();
          }
          // @ts-ignore
          if (this.responseCache[interceptedUrl]) {
            // console.log('from cached: ', interceptedUrl);
            // @ts-ignore
            interceptedRequest.respond(this.responseCache[interceptedUrl]);
          } else {
            interceptedRequest.continue().then(() => {
              const response = interceptedRequest.response();
              if (response) {
                // @ts-ignore
                const headers = response.headers();
                response.buffer().then((buffer: Buffer) => {
                  // console.log('caching: ', response.url());
                  // @ts-ignore
                  this.responseCache[response.url()] = {
                    headers: headers,
                    contentType: headers && headers['content-type'] ? headers['content-type'] : 'text/html',
                    // @ts-ignore
                    status: response.status(),
                    // @ts-ignore
                    body: buffer,
                  };
                  this.responseCacheSize++;
                });
              }
            });
          }
        } else {
          interceptedRequest.continue();
        }
      });

      // Page may reload when setting isMobile
      // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
      await page.setViewport({width: 340, height: 640, isMobile});

      if (isMobile) {
        page.setUserAgent(MOBILE_USERAGENT);
      }

      page.evaluateOnNewDocument('customElements.forcePolyfill = true');
      page.evaluateOnNewDocument('ShadyDOM = {force: true}');
      page.evaluateOnNewDocument('ShadyCSS = {shimcssproperties: true}');

      let response: puppeteer.Response | null = null;
      // Capture main frame response. This is used in the case that rendering
      // times out, which results in puppeteer throwing an error. This allows us
      // to return a partial response for what was able to be rendered in that
      // time frame.
      page.addListener('response', (r: puppeteer.Response) => {
        if (!response) {
          response = r;
        }
      });

      try {
        // Navigate to page. Wait until there are no oustanding network requests.
        response = await page.goto(
            requestUrl, {timeout: 10000, waitUntil: 'networkidle2'});
      } catch (e) {
        console.error(e);
      }

      if (!response) {
        console.error('response does not exist');
        // This should only occur when the page is about:blank. See
        // https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md#pagegotourl-options.
        return {status: 400, content: ''};
      }

      // Disable access to compute metadata. See
      // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
      if (response.headers()['metadata-flavor'] === 'Google') {
        return {status: 403, content: ''};
      }

      // Set status to the initial server's response code. Check for a <meta
      // name="render:status_code" content="4xx" /> tag which overrides the status
      // code.
      let statusCode = response.status();
      const newStatusCode =
          await page
              .$eval(
                  'meta[name="render:status_code"]',
                  (element) => parseInt(element.getAttribute('content') || ''))
              .catch(() => undefined);
      // On a repeat visit to the same origin, browser cache is enabled, so we may
      // encounter a 304 Not Modified. Instead we'll treat this as a 200 OK.
      if (statusCode === 304) {
        statusCode = 200;
      }
      // Original status codes which aren't 200 always return with that status
      // code, regardless of meta tags.
      if (statusCode === 200 && newStatusCode) {
        statusCode = newStatusCode;
      }

      // Remove script & import tags.
      await page.evaluate(stripPage);
      // Inject <base> tag with the origin of the request (ie. no path).
      const parsedUrl = url.parse(requestUrl);
      await page.evaluate(
          injectBaseHref, `${parsedUrl.protocol}//${parsedUrl.host}`);
      // await page.evaluate( () => {
      //   const polyfillString = '!function(e,n,t){function r(e,n){return typeof e===n}function o(){var e,n,t,o,s,i,l;for(var a in C)if(C.hasOwnProperty(a)){if(e=[],n=C[a],n.name&&(e.push(n.name.toLowerCase()),n.options&&n.options.aliases&&n.options.aliases.length))for(t=0;t<n.options.aliases.length;t++)e.push(n.options.aliases[t].toLowerCase());for(o=r(n.fn,"function")?n.fn():n.fn,s=0;s<e.length;s++)i=e[s],l=i.split("."),1===l.length?Modernizr[l[0]]=o:(!Modernizr[l[0]]||Modernizr[l[0]]instanceof Boolean||(Modernizr[l[0]]=new Boolean(Modernizr[l[0]])),Modernizr[l[0]][l[1]]=o),x.push((o?"":"no-")+l.join("-"))}}function s(e){var n=S.className,t=Modernizr._config.classPrefix||"";if(_&&(n=n.baseVal),Modernizr._config.enableJSClass){var r=new RegExp("(^|\\\\s)"+t+"no-js(\\\\s|$)");n=n.replace(r,"$1"+t+"js$2")}Modernizr._config.enableClasses&&(n+=" "+t+e.join(" "+t),_?S.className.baseVal=n:S.className=n)}function i(e,n){return!!~(""+e).indexOf(n)}function l(){return"function"!=typeof n.createElement?n.createElement(arguments[0]):_?n.createElementNS.call(n,"http://www.w3.org/2000/svg",arguments[0]):n.createElement.apply(n,arguments)}function a(e){return e.replace(/([a-z])-([a-z])/g,function(e,n,t){return n+t.toUpperCase()}).replace(/^-/,"")}function f(e,n){return function(){return e.apply(n,arguments)}}function u(e,n,t){var o;for(var s in e)if(e[s]in n)return t===!1?e[s]:(o=n[e[s]],r(o,"function")?f(o,t||n):o);return!1}function d(e){return e.replace(/([A-Z])/g,function(e,n){return"-"+n.toLowerCase()}).replace(/^ms-/,"-ms-")}function c(n,t,r){var o;if("getComputedStyle"in e){o=getComputedStyle.call(e,n,t);var s=e.console;if(null!==o)r&&(o=o.getPropertyValue(r));else if(s){var i=s.error?"error":"log";s[i].call(s,"getComputedStyle returning null, its possible modernizr test results are inaccurate")}}else o=!t&&n.currentStyle&&n.currentStyle[r];return o}function p(){var e=n.body;return e||(e=l(_?"svg":"body"),e.fake=!0),e}function m(e,t,r,o){var s,i,a,f,u="modernizr",d=l("div"),c=p();if(parseInt(r,10))for(;r--;)a=l("div"),a.id=o?o[r]:u+(r+1),d.appendChild(a);return s=l("style"),s.type="text/css",s.id="s"+u,(c.fake?c:d).appendChild(s),c.appendChild(d),s.styleSheet?s.styleSheet.cssText=e:s.appendChild(n.createTextNode(e)),d.id=u,c.fake&&(c.style.background="",c.style.overflow="hidden",f=S.style.overflow,S.style.overflow="hidden",S.appendChild(c)),i=t(d,e),c.fake?(c.parentNode.removeChild(c),S.style.overflow=f,S.offsetHeight):d.parentNode.removeChild(d),!!i}function y(n,r){var o=n.length;if("CSS"in e&&"supports"in e.CSS){for(;o--;)if(e.CSS.supports(d(n[o]),r))return!0;return!1}if("CSSSupportsRule"in e){for(var s=[];o--;)s.push("("+d(n[o])+":"+r+")");return s=s.join(" or "),m("@supports ("+s+") { #modernizr { position: absolute; } }",function(e){return"absolute"==c(e,null,"position")})}return t}function g(e,n,o,s){function f(){d&&(delete E.style,delete E.modElem)}if(s=r(s,"undefined")?!1:s,!r(o,"undefined")){var u=y(e,o);if(!r(u,"undefined"))return u}for(var d,c,p,m,g,v=["modernizr","tspan","samp"];!E.style&&v.length;)d=!0,E.modElem=l(v.shift()),E.style=E.modElem.style;for(p=e.length,c=0;p>c;c++)if(m=e[c],g=E.style[m],i(m,"-")&&(m=a(m)),E.style[m]!==t){if(s||r(o,"undefined"))return f(),"pfx"==n?m:!0;try{E.style[m]=o}catch(h){}if(E.style[m]!=g)return f(),"pfx"==n?m:!0}return f(),!1}function v(e,n,t,o,s){var i=e.charAt(0).toUpperCase()+e.slice(1),l=(e+" "+P.join(i+" ")+i).split(" ");return r(n,"string")||r(n,"undefined")?g(l,n,o,s):(l=(e+" "+T.join(i+" ")+i).split(" "),u(l,n,t))}function h(e,n,r){return v(e,t,t,n,r)}var x=[],C=[],w={_version:"3.6.0",_config:{classPrefix:"",enableClasses:!0,enableJSClass:!0,usePrefixes:!0},_q:[],on:function(e,n){var t=this;setTimeout(function(){n(t[e])},0)},addTest:function(e,n,t){C.push({name:e,fn:n,options:t})},addAsyncTest:function(e){C.push({name:null,fn:e})}},Modernizr=function(){};Modernizr.prototype=w,Modernizr=new Modernizr;var S=n.documentElement,_="svg"===S.nodeName.toLowerCase(),b="Moz O ms Webkit",P=w._config.usePrefixes?b.split(" "):[];w._cssomPrefixes=P;var T=w._config.usePrefixes?b.toLowerCase().split(" "):[];w._domPrefixes=T;var z={elem:l("modernizr")};Modernizr._q.push(function(){delete z.elem});var E={style:z.elem.style};Modernizr._q.unshift(function(){delete E.style}),w.testAllProps=v,w.testAllProps=h,Modernizr.addTest("flexbox",h("flexBasis","1px",!0)),Modernizr.addTest("flexboxlegacy",h("boxDirection","reverse",!0)),Modernizr.addTest("flexboxtweener",h("flexAlign","end",!0)),Modernizr.addTest("flexwrap",h("flexWrap","wrap",!0)),o(),s(x),delete w.addTest,delete w.addAsyncTest;for(var N=0;N<Modernizr._q.length;N++)Modernizr._q[N]();e.Modernizr=Modernizr}(window,document);';
      //   const head = document.getElementsByTagName('head')[0];
      //   const script = document.createElement('script');
      //   script.type = 'text/javascript';
      //   script.innerHTML = polyfillString;
      //   // script.onload = function() {
      //   //   callFunctionFromScript();
      //   // }
      //   // script.src = 'path/to/your-script.js';
      //   head.appendChild(script);
      // });

      // await page.evaluate( () => {
      //   // const customStyleToInject = 'div[class^="styles__MainContainer-"] > div{flex-flow:row wrap;}section[class^="ProductCarousal__ProductImage"]{height:267px;}section[class^="ProductCarousal__ProductImage"] + div{flex-flow:row wrap;}';
      //   const customStyleToInject = 'div[class^="Row-"]{flex-flow:row wrap;}div[class^="Col-"]{flex-flow:row wrap;}';
      //   const head = document.getElementsByTagName('head')[0];
      //   const style = document.createElement('style');
      //     style.setAttribute('type', 'text/css');
      //
      //     if ('textContent' in style) {
      //         style.textContent = customStyleToInject;
      //     } else {
      //         // @ts-ignore
      //         style.styleSheet.cssText = customStyleToInject;
      //     }
      //   // style.type = 'text/css';
      //   // style.innerHTML = customStyleToInject;
      //   // script.onload = function() {
      //   //   callFunctionFromScript();
      //   // }
      //   // script.src = 'path/to/your-script.js';
      //   head.appendChild(style);
      // });
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('style')).forEach((style) => {
        // @ts-ignore
            if (style && style.sheet && style.sheet.functionCallLogs) {
                // @ts-ignore
                console.log(style.sheet.functionCallLogs);
                // style.setAttribute('data-styles-rules', JSON.stringify(Array.from(style.sheet.rules).map((rule) => rule.cssText)));
                // @ts-ignore
                style.setAttribute('data-function-call-logs', JSON.stringify(style.sheet.functionCallLogs));
            } else {
                style.setAttribute('data-function-call-logs', JSON.stringify([]));
            }
          // if (style.innerHTML === '') {
            // @ts-ignore
            //   style.dataStyleRules = JSON.stringify(style.sheet.rules);
            // console.log(style.dataset.styleRules);
            // style.setAttribute('data-styles-rules', JSON.stringify(Array.from(style.sheet.rules).map((rule) => rule.cssText)));
            // @ts-ignore
                // .replace(/flex-direction:\s?column;/, 'flex-direction: row;');

              //      style.innerHTML = Array.from(style.sheet.rules)
            // // @ts-ignore
            //     .map((rule) => rule.cssText)
            //     .join('');
            //     // .replace(/flex-direction:\s?column;/, 'flex-direction: row;');
          // }
        });
      });
        await page.evaluate( () => {
            // document.querySelectorAll('style').forEach((style) => {var rules = [];if (style && style.dataset && style.dataset.stylesRules){try{rules = JSON.parse(style.dataset.stylesRules);}catch(error){console.log('parsing error', error);}}console.log(rules);rules.forEach((args) =>{try{console.log('typeof args',typeof args);style.sheet.insertRule.apply(style.sheet, [args[0]])}catch(error){console.log('error executing insert rule', error)}});});
            // document.querySelectorAll('style').forEach((style) => {try {if (style.dataStyleRules){style.setAttribute('css', 'randomcss');var rules = JSON.parse(style.dataStyleRules);style.style.rules = rules;}} catch(error){console.log('error Parsing rules' , error);}});
            const head = document.getElementsByTagName('head')[0];
            const script = document.createElement('script');
            script.type = 'text/javascript';
            script.innerHTML = 'document.querySelectorAll(\'style\').forEach((style) => {var rules = [];if (style && style.dataset && style.dataset.functionCallLogs){try{functionCallLogs = JSON.parse(style.dataset.functionCallLogs);}catch(error){console.log(\'parsing error\', error);}}console.log(rules);functionCallLogs.forEach((callLog) =>{try{console.log(callLog);const key = callLog.pop();style.sheet[key].apply(style.sheet, callLog)}catch(error){console.log(\`error executing function in sheet\`, error)}});});';
            // script.onload = function() {
            //   callFunctionFromScript();
            // }
            // script.src = 'path/to/your-script.js';
            head.appendChild(script);
        });

      // Serialize page.
      const result = await page.evaluate('document.firstElementChild.outerHTML');

      await page.close();
      await newIncognitoBrowserContext.close();
      return {status: statusCode, content: result};
    });
  }

  async screenshot(
      url: string,
      isMobile: boolean,
      dimensions: ViewportDimensions,
      options?: object): Promise<Buffer> {
    return await this.browserPool.acquire(async (browser: Browser) => {

      const page = await browser.newPage();

      // Page may reload when setting isMobile
      // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
      await page.setViewport(
          {width: dimensions.width, height: dimensions.height, isMobile});

      if (isMobile) {
        page.setUserAgent(MOBILE_USERAGENT);
      }

      let response: puppeteer.Response | null = null;

      try {
        // Navigate to page. Wait until there are no oustanding network requests.
        response =
            await page.goto(url, {timeout: 10000, waitUntil: 'networkidle2'});
      } catch (e) {
        console.error(e);
      }

      if (!response) {
        throw new ScreenshotError('NoResponse');
      }

      // Disable access to compute metadata. See
      // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
      if (response!.headers()['metadata-flavor'] === 'Google') {
        throw new ScreenshotError('Forbidden');
      }

      // Must be jpeg & binary format.
      const screenshotOptions =
          Object.assign({}, options, {type: 'jpeg', encoding: 'binary'});
      // Screenshot returns a buffer based on specified encoding above.
      // https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#pagescreenshotoptions
      const buffer = await page.screenshot(screenshotOptions) as Buffer;
      return buffer;
    });
  }
}

type ErrorType = 'Forbidden'|'NoResponse';

export class ScreenshotError extends Error {
  type: ErrorType;

  constructor(type: ErrorType) {
    super(type);

    this.name = this.constructor.name;

    this.type = type;
  }
}
