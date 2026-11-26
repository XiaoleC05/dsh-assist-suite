// pro-prompt (输入增强) — browser half.
//
// Plain browser module in the Dynamic ModuleLoader format used by DSH client
// plugins. React comes from the shared module table; no JSX and no
// build step.
//
// Surfaces:
//   - one entry in the left Sidebar and its main-area page (id `pro-prompt`):
//     two optimization modes, default-mode setting, service status, and the
//     agent-input constraints;
//   - one page in the right Sidebar (kind `proPrompt`) with the same panel;
//   - two functional controls in every composer tool row: optimize (direct, no
//     confirmation) and voice toggle (start / stop + insert). Configuration
//     lives in the sidebar, never in the composer.
//
// No template library, no prompt history, no audio history, and no key input.
// The only persisted preference is the default mode, written to the existing
// profile config by the host.

window.__ModuleLoader__.load({
  id: 'pro-prompt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'proPrompt';
    const PLUGIN_ID = 'pro-prompt';
    const TAB_KIND = 'proPrompt';
    const API_BASE = '/pro-prompt';
    const STYLE_ID = PLUGIN_ID + '/client.css';
    const VERSION = '1.4.0';
    const LEGACY_STORAGE_KEYS = [
      'dsh.prompt-studio.voice.prefs.v1',
      'dsh.prompt-studio.voice.history.v1',
    ];

    const MODES = [
      {
        id: 'structure',
        name: '结构优化',
        description: '分析任务并构建完整提示词：选择 DSH skill/MCP/插件，写清输入、处理、输出与验收；事实不足用执行前确认，绝不编造。',
      },
      {
        id: 'faithful',
        name: '保真润色',
        description: '100% 保留原意，只修语序、残句、歧义与口头禅；不新增结构、事实或要求。',
      },
    ];

    // Display copy for the sidebar. Keep the titles in sync with the host's
    // AGENT_CONSTRAINTS in lib/prompts.js; test/client.test.js asserts this.
    const AGENT_CONSTRAINTS = [
      ['目标明确', '第一句写清要智能体做什么；保留原文已有的角色与背景，不补造。'],
      ['结构与上下文分离', '任务、背景/输入、约束、输出、验收分开表达；没有的节不硬凑。'],
      ['事实保真', '事实、数字、专名、时间、约束、示例、代码原样保留，不补充、不推测。'],
      ['约束可执行', '逐条保留硬性限制，把模糊动词改成可检查的说法，不新增限制。'],
      ['输出明确', '写清交付物、格式与语言；原文未要求时不发明格式。'],
      ['验收明确', '保留已有验收标准；缺失时用执行前确认协议或执行约定，不写占位符。'],
      ['歧义不臆测', '信息不足时用执行前确认协议，不替用户假设具体事实。'],
      ['精简无冗余', '删除重复、空泛、客套和口头禅；不解释、不加元评论。'],
      ['代码任务先读后改', '涉及代码时保留先阅读相关文件、最小改动、说明验证结果的原始要求。'],
    ];

    const STRINGS = {
      tabTitle: '增强',
      tabGuideTitle: '输入增强',
      tabGuideDesc: '语音输入与提示词优化',
      panelTitle: '输入增强',
      panelSubtitle: '语音输入与提示词优化',
      refresh: '刷新',
      retry: '重试',
      cancel: '取消',
      statusChecking: '正在检查服务…',
      statusReady: '服务已就绪',
      statusPartialAsr: '语音已就绪，优化密钥未配置',
      statusPartialChat: '优化已就绪，语音密钥未配置',
      statusMissing: '未配置密钥',
      statusError: '服务状态不可用',
      chatSourceLabel: '润色密钥：{source}',
      asrSourceLabel: '识别密钥：{source}',
      sectionMode: '优化模式',
      sectionModeDesc: '两种模式同时作用于提示词优化和语音润色；选择后立即生效。',
      defaultMode: '默认模式',
      defaultModeValue: '默认模式：{mode}',
      setDefault: '将当前模式设为默认',
      alreadyDefault: '当前模式已是默认',
      retryDefault: '重试写入默认',
      defaultBadgeRunOnly: '默认（仅本次）',
      defaultModeValueRunOnly: '默认模式：{mode}（仅本次运行）',
      savingDefault: '正在保存…',
      defaultSaved: '默认模式已写入配置',
      sectionVoice: '语音输入',
      sectionVoiceDesc: '语音识别：SiliconFlow · Qwen/Qwen3-ASR-1.7B；语音润色/优化：SiliconFlow · DeepSeek-V4.1-Flash。',
      voiceMissing: '未配置 SiliconFlow 密钥',
      voiceMissingHint: '请在 profile 级 cordis.patch.yml 中设置 apiKey（SiliconFlow），用于 Qwen/Qwen3-ASR-1.7B 与 DeepSeek-V4.1-Flash。',
      asrModel: '语音识别',
      asrProvider: '识别服务',
      polishModel: '语音润色',
      language: '识别语言',
      langZh: '中文',
      langAuto: '自动',
      langEn: '英文',
      maxSeconds: '最长录音',
      seconds: '{n} 秒',
      voiceHint: '输入框左侧麦克风：点击开始录音，再点一次停止并插入识别文本。',
      voicePrivacy: '录音只在识别时临时发送，不落盘；不保存语音历史。',
      sectionOptimize: '提示词优化',
      optimizeDesc: '输入框左侧 ✦ 按钮：点击后直接优化当前输入并替换，不弹确认。',
      currentMode: '当前模式：{mode}',
      modelLine: '优化模型：{model}',
      constraintsSummary: '查看 {n} 条约束',
      privacy: '不保存提示词、音频或历史记录；不创建额外存储空间。',
      version: '版本 {v}',
      composerOptimizeTitle: '优化输入（{mode}）',
      composerVoice: '语音输入',
      composerVoiceStop: '停止录音并识别',
      composerKeyMissing: '语音输入（未配置识别密钥）',
      toastEmpty: '输入框为空，请先输入要优化的内容',
      toastKeyMissing: '未配置 SiliconFlow 密钥，请检查 profile 配置',
      toastAsrKeyMissing: '未配置 SiliconFlow 密钥',
      toastOptimized: '已用「{mode}」优化并替换输入框',
      toastOptimizedChanged: '优化期间输入有改动，结果已插入光标处',
      toastApplyFailed: '未能写入输入框（可能正忙）',
      toastOptimizeFailed: '优化失败',
      toastVoiceInserted: '已插入语音识别文本',
      toastVoiceEmpty: '没有识别到实质内容',
      toastVoiceFallback: '润色未返回有效内容，已插入识别原文',
      toastVoiceError: '语音处理失败',
      toastVoiceCancelled: '已取消语音输入',
      toastDefaultRunOnly: '默认模式已在本次运行生效',
      requesting: '正在请求麦克风…',
      processing: '正在识别并润色…',
      requestingShort: '请求麦克风…',
      processingShort: '识别中…',
      voiceTooShort: '录音太短，请再说一次。',
      micDenied: '麦克风权限被拒绝，请在系统设置中允许。',
      micUnavailable: '当前环境不支持麦克风录音。',
      insecure: '麦克风需要 HTTPS 或 localhost。',
      noMic: '没有找到可用的麦克风',
      micBusy: '麦克风被其他程序占用',
      modeDefaultBadge: '默认',
    };

    function format(text, params) {
      if (params === undefined || params === null) return text;
      return String(text).replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
      });
    }

    function makeT(ctx) {
      let bound = null;
      try {
        bound = ctx !== null && ctx.locale !== undefined && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null;
      } catch {
        bound = null;
      }
      return function t(key, params) {
        let value = null;
        if (typeof bound === 'function') {
          try {
            value = bound(key);
          } catch {
            value = null;
          }
        }
        if (typeof value !== 'string' || value === '') value = STRINGS[key];
        if (typeof value !== 'string') value = key;
        return format(value, params);
      };
    }

    function modeById(id) {
      return MODES.find(function (mode) { return mode.id === id; }) || MODES[0];
    }

    function modeName(id) {
      return modeById(id).name;
    }

    function clsx() {
      const parts = [];
      for (let index = 0; index < arguments.length; index += 1) {
        if (arguments[index]) parts.push(arguments[index]);
      }
      return parts.join(' ');
    }

    // ------------------------------------------------------------------
    // icons
    // ------------------------------------------------------------------

    function Icon({ size = 16, children, ...rest }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.9,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...rest,
      }, children);
    }

    function SparklesIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(Icon, { size },
        h('path', { d: 'M12 3.2l1.55 4.7 4.7 1.55-4.7 1.55L12 15.7l-1.55-4.7-4.7-1.55 4.7-1.55L12 3.2z' }),
        h('path', { d: 'M18.5 14.2l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1z' }),
      );
    }

    function MicIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(Icon, { size },
        h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }),
        h('path', { d: 'M12 18v3' }),
      );
    }

    function StopIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(Icon, { size }, h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: 'currentColor', stroke: 'none' }));
    }

    function RefreshIcon(props) {
      const size = props && props.size ? props.size : 14;
      return h(Icon, { size },
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 6.3' }),
        h('path', { d: 'M20 5v6h-6' }),
      );
    }

    function CheckIcon(props) {
      const size = props && props.size ? props.size : 14;
      return h(Icon, { size }, h('path', { d: 'M5 12.5l4.2 4.2L19 6.8' }));
    }

    function AlertIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(Icon, { size },
        h('path', { d: 'M12 4l8.5 15h-17L12 4z' }),
        h('path', { d: 'M12 9.5v4.2' }),
        h('path', { d: 'M12 16.8h.01' }),
      );
    }

    function Spinner({ small }) {
      return h('span', { className: clsx('pp-spinner', small ? 'pp-spinner-sm' : ''), 'aria-hidden': 'true' });
    }

    function Button({ variant, disabled, children, className, ...rest }) {
      return h('button', {
        type: 'button',
        disabled,
        className: clsx('pp-btn', 'pp-btn-' + (variant || 'secondary'), className),
        ...rest,
      }, children);
    }

    // ------------------------------------------------------------------
    // studio store
    // ------------------------------------------------------------------

    function defaultServer() {
      return {
        enabled: true,
        configured: false,
        source: 'none',
        sourceLabel: '未配置',
        asrConfigured: false,
        asrSource: 'none',
        asrSourceLabel: '未配置',
        asrProvider: 'SiliconFlow',
        asrModel: 'Qwen/Qwen3-ASR-1.7B',
        polishModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
        language: 'zh',
        maxSeconds: 60,
        defaultMode: 'structure',
        defaultPersisted: true,
      };
    }

    function createStudio() {
      let state = {
        status: 'idle',
        error: null,
        server: defaultServer(),
        mode: 'structure',
        modeTouched: false,
        defaultMode: 'structure',
        defaultPersisted: true,
      };
      const listeners = new Set();
      let loading = null;

      function emit() {
        listeners.forEach(function (listener) { listener(); });
      }

      function set(patch) {
        state = { ...state, ...patch };
        emit();
      }

      async function request(path, options) {
        const opts = options || {};
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(function () {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs || 20000);
        const external = opts.signal;
        const forward = function () { controller.abort(); };
        if (external !== undefined && external !== null) {
          if (external.aborted) controller.abort();
          else external.addEventListener('abort', forward, { once: true });
        }
        try {
          const response = await fetch(API_BASE + path, {
            method: opts.method || 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: opts.body,
            signal: controller.signal,
          });
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          if (!response.ok || payload === null || payload.ok !== true) {
            const detail = payload !== null && payload.error !== undefined && payload.error !== null ? payload.error : null;
            const message = detail !== null && typeof detail.message === 'string'
              ? detail.message
              : '输入增强服务返回错误（HTTP ' + response.status + '）';
            const code = detail !== null && typeof detail.code === 'string' ? detail.code : 'HTTP_' + response.status;
            const error = new Error(message);
            error.code = code;
            error.status = response.status;
            throw error;
          }
          return payload.data;
        } catch (error) {
          if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.status !== undefined) throw error;
          if (timedOut) {
            const timeout = new Error('请求超时，请稍后重试');
            timeout.code = 'TIMEOUT';
            throw timeout;
          }
          if (external !== undefined && external !== null && external.aborted) {
            const aborted = new Error('请求已取消');
            aborted.code = 'ABORTED';
            throw aborted;
          }
          const network = new Error('无法连接输入增强服务，请确认 DSH 正在运行后重试');
          network.code = 'NETWORK';
          throw network;
        } finally {
          clearTimeout(timer);
          if (external !== undefined && external !== null) external.removeEventListener('abort', forward);
        }
      }

      function applyStatus(data) {
        const defaultMode = data.defaultMode === 'structure' ? 'structure' : 'faithful';
        const defaultPersisted = data.defaultPersisted !== false;
        const source = data !== null && typeof data === 'object' ? data : {};
        const patch = {
          status: 'ready',
          error: null,
          server: {
            ...defaultServer(),
            ...source,
            defaultMode,
            defaultPersisted,
            configured: source.configured === true,
            asrConfigured: source.asrConfigured === true,
          },
          defaultMode,
          defaultPersisted,
        };
        if (!state.modeTouched) patch.mode = defaultMode;
        set(patch);
      }

      async function load(force) {
        if (!force && (state.status === 'ready' || state.status === 'loading')) return;
        if (loading !== null) return loading;
        set({ status: 'loading', error: null });
        loading = (async function () {
          try {
            const data = await request('/status', { timeoutMs: 15000 });
            applyStatus(data);
          } catch (error) {
            set({
              status: 'error',
              error: error !== null && typeof error.message === 'string' ? error.message : '服务状态不可用',
            });
          } finally {
            loading = null;
          }
        })();
        return loading;
      }

      function setMode(mode) {
        const normalized = mode === 'structure' ? 'structure' : 'faithful';
        set({ mode: normalized, modeTouched: true });
        return normalized;
      }

      async function setDefaultMode(mode) {
        const normalized = mode === 'structure' ? 'structure' : 'faithful';
        const data = await request('/default-mode', {
          method: 'POST',
          timeoutMs: 20000,
          body: JSON.stringify({ mode: normalized }),
        });
        const applied = data !== null && typeof data === 'object' && data.mode === 'structure' ? 'structure' : normalized;
        const persisted = data !== null && typeof data === 'object' && data.persisted === true;
        const patch = {
          defaultMode: applied,
          defaultPersisted: persisted,
          server: { ...state.server, defaultMode: applied, defaultPersisted: persisted },
        };
        if (!state.modeTouched) patch.mode = applied;
        set(patch);
        return data;
      }

      async function optimize(text, mode, signal) {
        return await request('/optimize', {
          method: 'POST',
          timeoutMs: 200000,
          signal,
          body: JSON.stringify({ text, mode }),
        });
      }

      async function processVoice(audioBase64, mode, language, signal) {
        return await request('/voice/process', {
          method: 'POST',
          timeoutMs: 200000,
          signal,
          body: JSON.stringify({ audio: audioBase64, mode, language }),
        });
      }

      function getMode() {
        return state.mode;
      }

      return {
        getSnapshot: function () { return state; },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        ensureLoaded: function () { return load(false); },
        refresh: function () { return load(true); },
        setMode,
        setDefaultMode,
        optimize,
        processVoice,
        getMode,
      };
    }

    // ------------------------------------------------------------------
    // voice recording
    // ------------------------------------------------------------------

    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(index + chunk, bytes.length)));
      }
      return btoa(binary);
    }

    function encodeWav(samples, sampleRate) {
      const dataSize = samples.length * 2;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);
      const writeText = function (offset, text) {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
      };
      writeText(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeText(8, 'WAVE');
      writeText(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeText(36, 'data');
      view.setUint32(40, dataSize, true);
      let offset = 44;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return buffer;
    }

    function chooseRecorderMimeType() {
      if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate;
      }
      return '';
    }

    /** Convert one MediaRecorder blob into canonical 16 kHz mono PCM16 WAV. */
    async function blobToVoiceAudio(blob) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (typeof AudioCtx !== 'function' || typeof OfflineCtx !== 'function') {
        throw new Error('当前浏览器不支持音频处理');
      }
      const arrayBuffer = await blob.arrayBuffer();
      const decodeContext = new AudioCtx();
      let decoded;
      try {
        decoded = await decodeContext.decodeAudioData(arrayBuffer.slice(0));
      } finally {
        try { await decodeContext.close(); } catch { /* already closed */ }
      }
      const durationMs = Math.round(decoded.duration * 1000);
      const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
      const offline = new OfflineCtx(1, frames, 16000);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      const samples = rendered.getChannelData(0);
      const wav = encodeWav(samples, 16000);
      return { base64: arrayBufferToBase64(wav), durationMs };
    }

    class VoiceRecorder {
      constructor(options) {
        const opts = options || {};
        this.onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : function () {};
        this.onError = typeof opts.onError === 'function' ? opts.onError : function () {};
        this.maxSeconds = opts.maxSeconds || 60;
        this.stream = null;
        this.mediaRecorder = null;
        this.chunks = [];
        this.audioContext = null;
        this.analyser = null;
        this.levelTimer = null;
        this.startedAt = 0;
        this.done = false;
        this.canceled = false;
        this.resolveStop = null;
        this.stopPromise = null;
      }

      elapsed() {
        return this.startedAt === 0 ? 0 : Math.max(0, performance.now() - this.startedAt);
      }

      async start() {
        if (window.isSecureContext === false) throw new Error('insecure-context');
        if (navigator.mediaDevices === undefined || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          throw new Error('media-unavailable');
        }
        if (typeof MediaRecorder === 'undefined') throw new Error('recorder-unavailable');
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (this.canceled) {
          this.releaseTracks();
          return;
        }
        const mimeType = chooseRecorderMimeType();
        this.mediaRecorder = mimeType === ''
          ? new MediaRecorder(this.stream)
          : new MediaRecorder(this.stream, { mimeType });
        this.chunks = [];
        this.done = false;
        this.stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });
        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data !== null && event.data !== undefined && event.data.size > 0) this.chunks.push(event.data);
        };
        this.mediaRecorder.onerror = (event) => {
          const error = event !== null && event !== undefined && event.error !== undefined ? event.error : new Error('录音失败');
          this.onError(error);
          this.finish(null);
        };
        this.mediaRecorder.onstop = () => {
          const type = this.mediaRecorder !== null && this.mediaRecorder.mimeType ? this.mediaRecorder.mimeType : (mimeType || 'audio/webm');
          const blob = new Blob(this.chunks, { type });
          const durationMs = this.elapsed();
          this.finish({ blob, durationMs });
        };
        this.startedAt = performance.now();
        this.mediaRecorder.start(200);
        this.startAnalyser();
      }

      startAnalyser() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (typeof AudioCtx !== 'function' || this.stream === null) return;
        try {
          this.audioContext = new AudioCtx();
          if (typeof this.audioContext.resume === 'function') this.audioContext.resume().catch(function () {});
          const source = this.audioContext.createMediaStreamSource(this.stream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 256;
          source.connect(this.analyser);
          const data = new Uint8Array(this.analyser.fftSize);
          this.levelTimer = setInterval(() => {
            if (this.analyser === null) return;
            this.analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let index = 0; index < data.length; index += 1) {
              const value = (data[index] - 128) / 128;
              sum += value * value;
            }
            const rms = Math.sqrt(sum / data.length);
            this.onLevel(Math.min(1, rms * 4.5));
          }, 100);
        } catch {
          // A level meter is optional; recording continues without it.
        }
      }

      releaseTracks() {
        if (this.stream !== null) {
          try {
            this.stream.getTracks().forEach(function (track) { track.stop(); });
          } catch {
            // Tracks may already be released.
          }
          this.stream = null;
        }
      }

      releaseAnalyser() {
        if (this.levelTimer !== null) {
          clearInterval(this.levelTimer);
          this.levelTimer = null;
        }
        this.analyser = null;
        if (this.audioContext !== null) {
          try { this.audioContext.close().catch(function () {}); } catch { /* already closed */ }
          this.audioContext = null;
        }
      }

      finish(result) {
        if (this.done) return;
        this.done = true;
        const resolve = this.resolveStop;
        this.resolveStop = null;
        this.releaseAnalyser();
        this.releaseTracks();
        this.onLevel(0);
        if (typeof resolve === 'function') resolve(result);
      }

      async stop() {
        if (this.mediaRecorder === null || this.mediaRecorder.state === 'inactive') return null;
        this.mediaRecorder.stop();
        return await (this.stopPromise || Promise.resolve(null));
      }

      cancel() {
        this.canceled = true;
        if (this.mediaRecorder !== null && this.mediaRecorder.state !== 'inactive') {
          try { this.mediaRecorder.stop(); } catch { /* already stopped */ }
        }
        this.finish(null);
      }
    }

    function voiceErrorText(error, t) {
      const name = error !== null && error !== undefined ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return t('micDenied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('noMic');
      if (name === 'NotReadableError') return t('micBusy');
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'insecure-context') return t('insecure');
      if (message === 'media-unavailable' || message === 'recorder-unavailable') return t('micUnavailable');
      return message || t('toastVoiceError');
    }

    /**
     * Write text into the closest composer.
     *
     * `replace` replaces the whole draft. `insert` prefers the host's cursor
     * insertion action, and falls back to appending a paragraph when the host
     * cannot report a selection.
     */
    function applyComposerText(inputActions, currentDraft, text, mode) {
      if (text === '' || inputActions === undefined || inputActions === null || typeof inputActions.setDraft !== 'function') return false;
      if (mode === 'replace') {
        inputActions.setDraft(text);
        return true;
      }
      const canInsert = typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function';
      if (canInsert) {
        try {
          const span = inputActions.captureInsertion();
          if (inputActions.insertText(text, span) === false) return false;
          return true;
        } catch {
          // Fall through to the whole-draft path when the host has no cursor API.
        }
      }
      const current = typeof currentDraft === 'string' ? currentDraft : '';
      const base = current.trim() === '' ? '' : current.replace(/\s+$/, '') + '\n\n';
      inputActions.setDraft(base + text);
      return true;
    }

    // ------------------------------------------------------------------
    // composer hooks
    // ------------------------------------------------------------------

    function useOptimizeController({ studio, t, flash, inputActions, draftRef }) {
      const [busy, setBusy] = React.useState(false);
      const abortRef = React.useRef(null);
      const mountedRef = React.useRef(true);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
          if (abortRef.current !== null) abortRef.current.abort();
        };
      }, []);

      const run = React.useCallback(async function () {
        if (busy) return;
        const submittedDraft = String(draftRef.current || '');
        const text = submittedDraft.trim();
        if (text === '') {
          flash(t('toastEmpty'));
          return;
        }
        const snapshot = studio.getSnapshot();
        if (snapshot.status === 'ready' && snapshot.server.configured !== true) {
          flash(t('toastKeyMissing'));
          return;
        }
        setBusy(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const mode = studio.getMode();
          const result = await studio.optimize(text, mode, controller.signal);
          if (!mountedRef.current) return;
          const currentDraft = String(draftRef.current || '');
          const changed = currentDraft !== submittedDraft;
          const applied = applyComposerText(inputActions, currentDraft, result.text, changed ? 'insert' : 'replace');
          if (!applied) {
            flash(t('toastApplyFailed'));
            return;
          }
          flash(changed
            ? t('toastOptimizedChanged')
            : t('toastOptimized', { mode: modeName(mode) }));
        } catch (error) {
          if (!mountedRef.current) return;
          if (controller.signal.aborted) return;
          flash(error !== null && typeof error.message === 'string' && error.message !== '' ? error.message : t('toastOptimizeFailed'));
        } finally {
          abortRef.current = null;
          if (mountedRef.current) setBusy(false);
        }
      }, [busy, studio, t, flash, inputActions, draftRef]);

      return { busy, run };
    }

    function useVoiceController({ studio, t, flash, inputActions, draftRef }) {
      const [phase, setPhaseState] = React.useState('idle');
      const phaseRef = React.useRef('idle');
      const [elapsed, setElapsed] = React.useState(0);
      const recorderRef = React.useRef(null);
      const abortRef = React.useRef(null);
      const mountedRef = React.useRef(true);
      const stopRef = React.useRef(function () {});

      const setPhase = React.useCallback(function (value) {
        phaseRef.current = value;
        setPhaseState(value);
      }, []);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
          if (recorderRef.current !== null) recorderRef.current.cancel();
          if (abortRef.current !== null) abortRef.current.abort();
        };
      }, []);

      const start = React.useCallback(async function () {
        if (phaseRef.current !== 'idle') return;
        const snapshot = studio.getSnapshot();
        if (snapshot.status === 'idle') studio.ensureLoaded();
        if (snapshot.status === 'ready' && snapshot.server.asrConfigured !== true) {
          flash(t('toastAsrKeyMissing'));
          return;
        }
        setElapsed(0);
        setPhase('requesting');
        const recorder = new VoiceRecorder({
          maxSeconds: snapshot.server.maxSeconds || 60,
          onError: function (failure) {
            if (!mountedRef.current) return;
            flash(voiceErrorText(failure, t));
            setPhase('idle');
          },
        });
        recorderRef.current = recorder;
        try {
          await recorder.start();
          if (!mountedRef.current || recorder.canceled) {
            recorder.cancel();
            return;
          }
          setPhase('recording');
        } catch (failure) {
          recorderRef.current = null;
          if (!mountedRef.current) return;
          flash(voiceErrorText(failure, t));
          setPhase('idle');
        }
      }, [studio, t, flash, setPhase]);

      const stop = React.useCallback(async function () {
        if (phaseRef.current !== 'recording') return;
        const recorder = recorderRef.current;
        setPhase('processing');
        setElapsed(recorder !== null ? recorder.elapsed() : 0);
        let captured = null;
        try {
          captured = recorder !== null ? await recorder.stop() : null;
        } catch (failure) {
          recorderRef.current = null;
          if (!mountedRef.current) return;
          flash(voiceErrorText(failure, t));
          setPhase('idle');
          return;
        }
        recorderRef.current = null;
        if (!mountedRef.current) return;
        if (captured === null || captured.blob === null) {
          setPhase('idle');
          return;
        }
        if (captured.durationMs < 500) {
          flash(t('voiceTooShort'));
          setPhase('idle');
          return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const audio = await blobToVoiceAudio(captured.blob);
          const data = await studio.processVoice(audio.base64, studio.getMode(), undefined, controller.signal);
          if (!mountedRef.current) return;
          if (data === null || typeof data !== 'object') {
            flash(t('toastVoiceError'));
            setPhase('idle');
            return;
          }
          if (typeof data.text !== 'string' || data.text.trim() === '' || data.empty === true) {
            flash(t('toastVoiceEmpty'));
            setPhase('idle');
            return;
          }
          const applied = applyComposerText(inputActions, draftRef.current, data.text, 'insert');
          if (!applied) {
            flash(t('toastApplyFailed'));
            setPhase('idle');
            return;
          }
          flash(typeof data.warning === 'string' && data.warning !== ''
            ? t('toastVoiceFallback')
            : t('toastVoiceInserted'));
          setPhase('idle');
        } catch (error) {
          if (!mountedRef.current) return;
          if (controller.signal.aborted) {
            setPhase('idle');
            return;
          }
          flash(error !== null && typeof error.message === 'string' && error.message !== '' ? error.message : t('toastVoiceError'));
          setPhase('idle');
        } finally {
          abortRef.current = null;
        }
      }, [studio, t, flash, inputActions, draftRef, setPhase]);

      stopRef.current = stop;

      const cancel = React.useCallback(function () {
        if (recorderRef.current !== null) {
          recorderRef.current.cancel();
          recorderRef.current = null;
        }
        if (abortRef.current !== null) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setPhase('idle');
        setElapsed(0);
        flash(t('toastVoiceCancelled'));
      }, [setPhase, flash, t]);

      React.useEffect(function () {
        if (phase !== 'recording') return undefined;
        const timer = setInterval(function () {
          const recorder = recorderRef.current;
          if (recorder === null) return;
          const current = recorder.elapsed();
          if (mountedRef.current) setElapsed(current);
          const limit = (studio.getSnapshot().server.maxSeconds || 60) * 1000;
          if (current >= limit) {
            clearInterval(timer);
            stopRef.current();
          }
        }, 100);
        return function () { clearInterval(timer); };
      }, [phase, studio]);

      const toggle = React.useCallback(function () {
        if (phaseRef.current === 'recording') {
          stop();
          return;
        }
        if (phaseRef.current === 'idle') start();
      }, [start, stop]);

      return { phase, elapsed, toggle, cancel };
    }

    // ------------------------------------------------------------------
    // composer controls
    // ------------------------------------------------------------------

    function ComposerButton(props) {
      const studio = props.studio;
      const t = typeof props.t === 'function' ? props.t : function (key) { return key; };
      const useInput = props.useInput;
      const inputActions = props.inputActions;
      const state = React.useSyncExternalStore(studio.subscribe, studio.getSnapshot);
      const draft = useInput(function (snapshot) { return snapshot.draft; });
      const draftRef = React.useRef(draft);
      const [notice, setNotice] = React.useState(null);
      const noticeTimer = React.useRef(null);
      draftRef.current = draft;

      const flash = React.useCallback(function (message) {
        setNotice(message);
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(function () { setNotice(null); }, 2800);
      }, []);

      React.useEffect(function () {
        return function () {
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        };
      }, []);

      const optimize = useOptimizeController({ studio, t, flash, inputActions, draftRef });
      const voice = useVoiceController({ studio, t, flash, inputActions, draftRef });
      const recording = voice.phase === 'recording';
      const voiceBusy = voice.phase === 'requesting' || voice.phase === 'processing';
      const asrMissing = state.status === 'ready' && state.server.asrConfigured !== true;
      const voiceTitle = asrMissing
        ? t('composerKeyMissing')
        : recording
          ? t('composerVoiceStop')
          : voiceBusy
            ? (voice.phase === 'requesting' ? t('requesting') : t('processing'))
            : t('composerVoice');

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'pp-composer-btn',
          'aria-label': t('composerOptimizeTitle', { mode: modeName(state.mode) }),
          title: t('composerOptimizeTitle', { mode: modeName(state.mode) }),
          'aria-busy': optimize.busy,
          disabled: optimize.busy,
          onMouseDown: function (event) { event.preventDefault(); },
          onClick: optimize.run,
        }, optimize.busy ? h(Spinner, { small: true }) : h(SparklesIcon, { size: 16 })),
        h('button', {
          type: 'button',
          className: clsx('pp-composer-btn', recording ? 'pp-composer-btn-recording' : ''),
          'aria-label': voiceTitle,
          title: voiceTitle,
          'aria-pressed': recording,
          'aria-busy': voiceBusy,
          disabled: voiceBusy,
          onMouseDown: function (event) { event.preventDefault(); },
          onClick: voice.toggle,
        },
          voiceBusy
            ? h(Spinner, { small: true })
            : recording
              ? h(StopIcon, { size: 16 })
              : h(MicIcon, { size: 17 }),
        ),
        recording
          ? h('span', { className: 'pp-rec-label', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'pp-rec-dot' }),
            formatElapsed(voice.elapsed),
          )
          : null,
        voiceBusy
          ? h('span', { className: 'pp-voice-status', role: 'status' },
            voice.phase === 'requesting' ? t('requestingShort') : t('processingShort'),
            h('button', {
              type: 'button',
              className: 'pp-linkbtn',
              onClick: voice.cancel,
            }, t('cancel')),
          )
          : null,
        notice !== null
          ? h('div', { className: 'pp-toast', role: 'status' }, notice)
          : null,
      );
    }

    // ------------------------------------------------------------------
    // sidebar panel
    // ------------------------------------------------------------------

    function SidebarPanel(props) {
      const studio = props.studio;
      const t = typeof props.t === 'function' ? props.t : function (key) { return key; };
      const state = React.useSyncExternalStore(studio.subscribe, studio.getSnapshot);
      const server = state.server;
      const activeMode = modeById(state.mode);
      const [savingDefault, setSavingDefault] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const toastTimer = React.useRef(null);

      const flash = React.useCallback(function (message) {
        setToast(message);
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(function () { setToast(null); }, 3200);
      }, []);

      React.useEffect(function () {
        studio.ensureLoaded();
        return function () {
          if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        };
      }, [studio]);

      const saveDefault = async function () {
        if (savingDefault) return;
        setSavingDefault(true);
        try {
          const result = await studio.setDefaultMode(state.mode);
          if (result !== null && result !== undefined && result.persisted === true) flash(t('defaultSaved'));
          else if (result !== null && result !== undefined && typeof result.warning === 'string' && result.warning !== '') flash(result.warning);
          else flash(t('toastDefaultRunOnly'));
        } catch (error) {
          flash(error !== null && typeof error.message === 'string' && error.message !== '' ? error.message : t('toastOptimizeFailed'));
        } finally {
          setSavingDefault(false);
        }
      };

      const chatConfigured = server.configured === true;
      const asrConfigured = server.asrConfigured === true;
      const bothConfigured = chatConfigured && asrConfigured;
      const statusText = state.status === 'idle' || state.status === 'loading'
        ? t('statusChecking')
        : state.status === 'error'
          ? t('statusError')
          : bothConfigured
            ? t('statusReady')
            : asrConfigured
              ? t('statusPartialAsr')
              : chatConfigured
                ? t('statusPartialChat')
                : t('statusMissing');
      const chatSourceText = server.source !== undefined && server.source !== 'none' && server.sourceLabel !== undefined
        ? t('chatSourceLabel', { source: server.sourceLabel })
        : '';
      const asrSourceText = server.asrSource !== undefined && server.asrSource !== 'none' && server.asrSourceLabel !== undefined
        ? t('asrSourceLabel', { source: server.asrSourceLabel })
        : '';

      const onModeKeyDown = function (event) {
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const currentIndex = Math.max(0, MODES.findIndex(function (mode) { return mode.id === state.mode; }));
        let nextIndex = currentIndex;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % MODES.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + MODES.length) % MODES.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = MODES.length - 1;
        const buttons = event.currentTarget.querySelectorAll('[role="radio"]');
        const nextButton = buttons[nextIndex];
        if (nextButton !== undefined) {
          nextButton.focus();
          studio.setMode(MODES[nextIndex].id);
        }
      };

      const modeCards = h('div', {
        className: 'pp-mode-grid',
        role: 'radiogroup',
        'aria-label': t('sectionMode'),
        onKeyDown: onModeKeyDown,
      },
        MODES.map(function (mode) {
          const selected = state.mode === mode.id;
          const isDefault = server.defaultMode === mode.id;
          return h('button', {
            key: mode.id,
            type: 'button',
            role: 'radio',
            'aria-checked': selected,
            tabIndex: selected ? 0 : -1,
            className: clsx('pp-mode-card', selected ? 'pp-mode-card-on' : ''),
            onClick: function () { studio.setMode(mode.id); },
          },
            h('span', { className: 'pp-mode-top' },
              h('span', { className: 'pp-mode-name' }, mode.name),
              isDefault
                ? h('span', { className: 'pp-mode-badge' }, server.defaultPersisted === false ? t('defaultBadgeRunOnly') : t('modeDefaultBadge'))
                : null,
            ),
            h('span', { className: 'pp-mode-desc' }, mode.description),
            selected ? h('span', { className: 'pp-mode-check' }, h(CheckIcon, { size: 13 })) : null,
          );
        }),
      );

      const isCurrentDefault = state.mode === server.defaultMode;
      const defaultPersisted = server.defaultPersisted !== false;
      const defaultRow = h('div', { className: 'pp-default-row' },
        h('div', { className: 'pp-default-text' },
          h('span', { className: 'pp-label' }, t('defaultMode')),
          h('span', { className: 'pp-default-value' }, defaultPersisted
            ? t('defaultModeValue', { mode: modeName(server.defaultMode) })
            : t('defaultModeValueRunOnly', { mode: modeName(server.defaultMode) })),
        ),
        h(Button, {
          variant: 'secondary',
          className: 'pp-btn-sm',
          disabled: savingDefault || (isCurrentDefault && defaultPersisted),
          onClick: saveDefault,
        }, savingDefault ? h(Spinner, { small: true }) : null, savingDefault
          ? t('savingDefault')
          : isCurrentDefault && defaultPersisted
            ? t('alreadyDefault')
            : isCurrentDefault
              ? t('retryDefault')
              : t('setDefault')),
      );

      const voiceSection = h('section', { className: 'pp-section' },
        h('div', { className: 'pp-section-head' },
          h('h2', { className: 'pp-section-title' }, t('sectionVoice')),
        ),
        h('p', { className: 'pp-section-desc' }, t('sectionVoiceDesc')),
        !asrConfigured && state.status !== 'loading' && state.status !== 'idle'
          ? h('div', { className: 'pp-warn', role: 'alert' },
            h(AlertIcon, { size: 15 }),
            h('div', null,
              h('strong', null, t('voiceMissing')),
              h('div', { className: 'pp-warn-detail' }, t('voiceMissingHint')),
            ),
          )
          : null,
        asrSourceText !== '' ? h('div', { className: 'pp-source' }, asrSourceText) : null,
        h('dl', { className: 'pp-kv' },
          h('div', null, h('dt', null, t('asrProvider')), h('dd', null, server.asrProvider)),
          h('div', null, h('dt', null, t('asrModel')), h('dd', null, server.asrModel)),
          h('div', null, h('dt', null, t('polishModel')), h('dd', null, server.polishModel)),
          h('div', null, h('dt', null, t('language')), h('dd', null, server.language === 'auto' ? t('langAuto') : server.language === 'en' ? t('langEn') : t('langZh'))),
          h('div', null, h('dt', null, t('maxSeconds')), h('dd', null, t('seconds', { n: server.maxSeconds }))),
        ),
        h('p', { className: 'pp-hint' }, t('voiceHint')),
        h('p', { className: 'pp-hint pp-hint-muted' }, t('voicePrivacy')),
      );

      const optimizeSection = h('section', { className: 'pp-section' },
        h('h2', { className: 'pp-section-title' }, t('sectionOptimize')),
        h('p', { className: 'pp-section-desc' }, t('optimizeDesc')),
        h('div', { className: 'pp-line' }, t('currentMode', { mode: activeMode.name })),
        h('div', { className: 'pp-line pp-line-muted' }, t('modelLine', { model: server.polishModel })),
        chatSourceText !== '' ? h('div', { className: 'pp-source' }, chatSourceText) : null,
        h('details', { className: 'pp-details' },
          h('summary', null, t('constraintsSummary', { n: AGENT_CONSTRAINTS.length })),
          h('ol', { className: 'pp-constraints' },
            AGENT_CONSTRAINTS.map(function (item, index) {
              return h('li', { key: index },
                h('strong', null, item[0]),
                h('span', null, '：' + item[1]),
              );
            }),
          ),
        ),
      );

      return h('section', { className: 'pp-panel', 'data-plugin': PLUGIN_ID },
        h('header', { className: 'pp-head' },
          h('div', { className: 'pp-head-row' },
            h('span', { className: 'pp-logo' }, h(SparklesIcon, { size: 17 })),
            h('div', { className: 'pp-head-text' },
              h('h1', { className: 'pp-title' }, t('panelTitle')),
              h('p', { className: 'pp-subtitle' }, t('panelSubtitle')),
            ),
            h('span', { className: 'pp-head-spacer' }),
            h('button', {
              type: 'button',
              className: 'pp-iconbtn',
              'aria-label': t('refresh'),
              title: t('refresh'),
              disabled: state.status === 'loading',
              onClick: function () { studio.refresh(); },
            }, state.status === 'loading' ? h(Spinner, { small: true }) : h(RefreshIcon, { size: 15 })),
          ),
          h('div', { className: clsx('pp-status-banner', bothConfigured ? 'pp-status-banner-on' : 'pp-status-banner-off') },
            h('span', { className: clsx('pp-dot', bothConfigured ? 'pp-dot-on' : 'pp-dot-off') }),
            h('span', { className: 'pp-status-text' }, statusText),
          ),
        ),
        h('div', { className: 'pp-body' },
          state.status === 'error'
            ? h('div', { className: 'pp-warn', role: 'alert' },
              h(AlertIcon, { size: 15 }),
              h('div', null,
                h('strong', null, t('statusError')),
                h('div', { className: 'pp-warn-detail' }, state.error || ''),
              ),
              h(Button, { variant: 'secondary', className: 'pp-btn-sm', onClick: function () { studio.refresh(); } }, t('retry')),
            )
            : null,
          h('section', { className: 'pp-section' },
            h('h2', { className: 'pp-section-title' }, t('sectionMode')),
            h('p', { className: 'pp-section-desc' }, t('sectionModeDesc')),
            modeCards,
            defaultRow,
          ),
          voiceSection,
          optimizeSection,
          h('footer', { className: 'pp-foot' },
            h('div', null, t('privacy')),
            h('div', { className: 'pp-foot-version' }, t('version', { v: VERSION })),
          ),
        ),
        toast !== null ? h('div', { className: 'pp-toast pp-toast-panel', role: 'status' }, toast) : null,
      );
    }

    // ------------------------------------------------------------------
    // styles
    // ------------------------------------------------------------------

    const CSS = `
.pp-panel, .pp-toast, .pp-composer-btn { box-sizing: border-box; }
.pp-panel *, .pp-toast * { box-sizing: border-box; }
.pp-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 1.5;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #fff));
}
.pp-head { flex: none; display: flex; flex-direction: column; gap: 9px; padding: 13px 14px 11px; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.pp-head-row { display: flex; align-items: center; gap: 9px; min-width: 0; }
.pp-logo { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 9px; color: var(--dsw-alias-bg-base, #fff); background: var(--dsw-alias-brand-primary, #4d6bfe); }
.pp-head-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pp-title { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: .01em; }
.pp-subtitle { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-head-spacer { flex: 1; }
.pp-iconbtn { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; }
.pp-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover-solid, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1f2328); }
.pp-iconbtn:disabled { opacity: .55; cursor: default; }
.pp-status-banner { display: flex; align-items: center; gap: 7px; padding: 5px 8px; border-radius: 7px; font-size: 11px; }
.pp-status-banner-on { color: var(--dsw-alias-label-primary, #1f2328); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a7f37) 10%, transparent); }
.pp-status-banner-off { color: var(--dsw-alias-label-primary, #1f2328); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #9a6700) 11%, transparent); }
.pp-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 12px; }
.pp-section { display: flex; flex-direction: column; gap: 9px; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.pp-section-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pp-section-title { margin: 0; font-size: 12px; font-weight: 650; letter-spacing: .01em; }
.pp-section-desc { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--dsw-alias-state-idle-primary, #8a8f98); }
.pp-dot-on { background: var(--dsw-alias-state-success-primary, #1a7f37); }
.pp-dot-off { background: var(--dsw-alias-state-warn-primary, #9a6700); }
.pp-mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pp-mode-card { position: relative; display: flex; flex-direction: column; gap: 5px; min-height: 104px; padding: 10px 9px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 9px; background: var(--dsw-alias-bg-base, transparent); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pp-mode-card:hover { border-color: var(--dsw-alias-border-l2, rgba(0,0,0,.2)); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03)); }
.pp-mode-card-on { border-color: var(--dsw-alias-brand-primary, #4d6bfe); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary, #4d6bfe); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 7%, var(--dsw-alias-bg-base, transparent)); }
.pp-mode-top { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; padding-right: 16px; }
.pp-mode-name { font-size: 12px; font-weight: 650; }
.pp-mode-badge { font-size: 10px; line-height: 1.4; padding: 0 5px; border-radius: 999px; color: var(--dsw-alias-brand-primary, #4d6bfe); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 40%, transparent); }
.pp-mode-desc { font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-mode-check { position: absolute; top: 8px; right: 8px; color: var(--dsw-alias-brand-primary, #4d6bfe); }
.pp-default-row { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
.pp-default-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.pp-label { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-default-value { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: 7px; font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
.pp-btn:disabled { opacity: .55; cursor: default; }
.pp-btn-sm { min-height: 26px; padding: 0 8px; font-size: 10.5px; }
.pp-btn-secondary { color: var(--dsw-alias-label-primary, #1f2328); border-color: var(--dsw-alias-border-l1, rgba(0,0,0,.14)); background: var(--dsw-alias-bg-base, transparent); }
.pp-btn-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, rgba(0,0,0,.04)); }
.pp-btn-ghost { color: var(--dsw-alias-label-secondary, #8a8f98); background: transparent; }
.pp-btn-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-interactive-bg-hover-solid, rgba(0,0,0,.04)); }
.pp-warn { display: flex; align-items: flex-start; gap: 7px; padding: 8px 9px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #9a6700) 35%, transparent); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2328); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #9a6700) 8%, transparent); font-size: 11.5px; line-height: 1.45; min-width: 0; overflow-wrap: anywhere; }
.pp-warn > svg { flex: none; color: var(--dsw-alias-state-warn-primary, #9a6700); }
.pp-warn-detail { color: var(--dsw-alias-label-secondary, #8a8f98); margin-top: 3px; }
.pp-warn .pp-btn { margin-left: auto; flex: none; }
.pp-source { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-kv { display: grid; grid-template-columns: 1fr; gap: 5px; margin: 0; }
.pp-kv > div { display: flex; align-items: baseline; gap: 8px; }
.pp-kv dt { flex: none; width: 68px; margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-kv dd { margin: 0; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-hint { margin: 0; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-hint-muted { opacity: .85; }
.pp-line { font-size: 11px; }
.pp-line-muted { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }
.pp-details { border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); padding-top: 7px; }
.pp-details summary { cursor: pointer; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); user-select: none; }
.pp-details summary:hover { color: var(--dsw-alias-label-primary, #1f2328); }
.pp-constraints { margin: 7px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-constraints strong { color: var(--dsw-alias-label-primary, #1f2328); font-weight: 600; }
.pp-foot { display: flex; flex-direction: column; gap: 3px; padding-top: 2px; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.pp-foot-version { opacity: .8; }
.pp-spinner { width: 13px; height: 13px; flex: none; border: 1.8px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: pp-spin .7s linear infinite; }
.pp-spinner-sm { width: 11px; height: 11px; border-width: 1.6px; }
@keyframes pp-spin { to { transform: rotate(360deg); } }
.pp-composer-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 28px; height: 28px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #1f2328); font: inherit; cursor: pointer; }
.pp-composer-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, rgba(0,0,0,.06)); }
.pp-composer-btn:disabled { opacity: .55; cursor: default; }
.pp-composer-btn-recording { color: var(--dsw-alias-state-error-primary, #c4314b); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c4314b) 10%, transparent); }
.pp-rec-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #1f2328); white-space: nowrap; }
.pp-rec-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--dsw-alias-state-error-primary, #c4314b); }
.pp-voice-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: nowrap; }
.pp-linkbtn { border: 0; padding: 0; background: transparent; color: var(--dsw-alias-brand-primary, #4d6bfe); font: inherit; font-size: 11px; cursor: pointer; }
.pp-linkbtn:hover { text-decoration: underline; }
.pp-toast { position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%); z-index: 9999; max-width: min(520px, calc(100vw - 32px)); padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16)); border-radius: 9px; color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-bg-overlay, #fff); box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary, #000) 16%, transparent); font-size: 12px; line-height: 1.45; }
.pp-toast-panel { position: absolute; left: 14px; right: 14px; bottom: 14px; transform: none; max-width: none; }
@media (hover: none) { .pp-mode-card:hover { background: var(--dsw-alias-bg-base, transparent); } }
`;

    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
      const element = document.createElement('style');
      element.dataset.plugin = PLUGIN_ID;
      element.dataset.pluginCss = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    // ------------------------------------------------------------------
    // plugin
    // ------------------------------------------------------------------

    // Pages are rendered as tabs inside the integrated assistant hub.
    const pages = []

    return {
      inject: ['slots', 'locale'],
      pages,
      __test: {
        encodeWav,
        formatElapsed,
        arrayBufferToBase64,
        applyComposerText,
        VoiceRecorder,
        blobToVoiceAudio,
        chooseRecorderMimeType,
        createStudio,
        STRINGS,
        MODES,
        AGENT_CONSTRAINTS,
      },
      apply(ctx) {
        if (ctx === null || typeof ctx !== 'object') return undefined;
        ensureStyles();
        try {
          for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key);
        } catch {
          // Older versions may have left storage entries; failing to remove them
          // must not block activation.
        }
        if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
          const register = function () { ctx.locale.register(NS, { zh: STRINGS, en: STRINGS }); };
          if (typeof ctx.effect === 'function') ctx.effect(register, 'pro-prompt:locale');
          else register();
        }
        const t = makeT(ctx);
        const slots = ctx.slots;
        if (slots === null || slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          return undefined;
        }
        const studio = createStudio();
        studio.ensureLoaded();

        // Tab inside the integrated assistant hub: page component plus its props.
        pages.push({
          id: PLUGIN_ID,
          labelKey: 'panelTitle',
          locale: NS,
          component: SidebarPanel,
          props: function () { return { studio }; },
        });

        // The right-sidebar tab is optional: the left Sidebar entry above is the
        // plugin's primary surface, so a build without the tab service still
        // shows the plugin instead of returning before registration.
        let tabs;
        try {
          tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : ctx.sidebarRightTabs;
        } catch {
          try {
            tabs = ctx.sidebarRightTabs;
          } catch {
            tabs = undefined;
          }
        }
        if (tabs !== null && tabs !== undefined && typeof tabs.register === 'function') {
          ctx.effect(function () {
            return tabs.register({
              id: PLUGIN_ID,
              kind: TAB_KIND,
              priority: 'extension',
              multiple: false,
              keepMounted: true,
              title: function () { return t('tabTitle'); },
              guide: [
                {
                  id: 'pro-prompt',
                  order: 40,
                  title: function () { return t('tabGuideTitle'); },
                  description: function () { return t('tabGuideDesc'); },
                  icon: SparklesIcon,
                },
              ],
            });
          }, 'pro-prompt:tab-type');

          ctx.effect(function () {
            return slots.inject('sidebar.right.pane.tab', function () {
              return slots.register({
                name: 'sidebar.right.pane.tab',
                key: PLUGIN_ID,
                locale: NS,
                inject: function (sessionId) {
                  return { studio, sessionId: String(sessionId), t };
                },
              }, SidebarPanel);
            });
          }, 'pro-prompt:tab-body');
        }

        ctx.effect(function () {
          return slots.inject('conversation.input.left', function () {
            return slots.register({
              name: 'conversation.input.left',
              id: PLUGIN_ID,
              order: 20,
              locale: NS,
              inject: function (sessionId) {
                return {
                  studio,
                  sessionId: String(sessionId),
                  t,
                };
              },
            }, ComposerButton);
          });
        }, 'pro-prompt:composer');

        return undefined;
      },
    };
  },
});
