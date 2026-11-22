export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/data" && request.method === "GET") {
        return jsonResponse(await getCrudeData(env.UPSTOX_TOKEN));
      }

      if (url.pathname === "/api/all-data" && request.method === "GET") {
        return jsonResponse(await getAllDashboardData(env.UPSTOX_TOKEN));
      }

      if (url.pathname === "/mcp" && request.method === "POST") {
        return await handleMCP(request, env);
      }

      if (url.pathname === "/mcp") {
        return new Response("MCP endpoint: POST required.", {
          status: 405,
          headers: { Allow: "POST, OPTIONS" }
        });
      }

      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    } catch (error) {
      return jsonResponse({
        success: false,
        error: error.message
      }, 500);
    }
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

async function handleMCP(request, env) {
  const body = await request.json();

  const reply = (id, result) => jsonResponse({
    jsonrpc: "2.0",
    id,
    result
  });

  const errorReply = (id, code, message) => jsonResponse({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });

  if (!body || body.jsonrpc !== "2.0" || !body.method) {
    return errorReply(body?.id ?? null, -32600, "Invalid JSON-RPC request");
  }

  if (body.method === "initialize") {
    return reply(body.id, {
      protocolVersion: body.params?.protocolVersion || "2025-03-26",
      capabilities: {
        tools: { listChanged: false }
      },
      serverInfo: {
        name: "mcx-crude-oil-data",
        version: "2.3.0"
      },
      instructions:
        "Fetch MCX standard CRUDEOIL futures data. " +
        "Return only one active contract: current calendar month from the 1st through the 15th, " +
        "and the next calendar month from the 16th through month-end. " +
        "Never mix CRUDEOILM. The separate option chain contains only standard CRUDEOIL CE/PE contracts " +
        "using independently discovered options expiry, limited to ATM plus/minus 10 available strikes. " +
        "PCR and highest OI strikes are calculated from the full selected options expiry. " +
        "Technical indicators are calculated independently for 5-minute, 15-minute and 1-hour candles."
    });
  }

  if (body.method === "notifications/initialized") {
    return new Response(null, {
      status: 202,
      headers: corsHeaders()
    });
  }

  if (body.method === "ping") {
    return reply(body.id, {});
  }

  if (body.method === "tools/list") {
    return reply(body.id, {
      tools: [{
        name: "get_crude_futures",
        description:
          "Fetch the single active MCX standard CRUDEOIL futures contract selected by date. " +
          "Return quotes, latest completed 5-minute, 15-minute and 1-hour candles, " +
          "RSI14, VWAP, EMA20/50/200, ATR14, Supertrend, MACD, LRC and weighted CE/PE/NEUTRAL signals. " +
          "Also return standard CRUDEOIL CE/PE option chain ATM ± 10 available strikes. " +
          "PCR and highest OI use the full selected expiry. Never include CRUDEOILM.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true
        }
      }]
    });
  }

  if (body.method === "tools/call") {
    if (body.params?.name !== "get_crude_futures") {
      return errorReply(body.id, -32602, "Unknown tool");
    }

    try {
      const data = await getCrudeData(env.UPSTOX_TOKEN);

      return reply(body.id, {
        content: [{
          type: "text",
          text: JSON.stringify(data, null, 2)
        }],
        structuredContent: data,
        isError: false
      });
    } catch (error) {
      return reply(body.id, {
        content: [{ type: "text", text: error.message }],
        isError: true
      });
    }
  }

  if (body.id !== undefined) {
    return errorReply(body.id, -32601, "Method not found");
  }

  return new Response(null, {
    status: 202,
    headers: corsHeaders()
  });
}

// Every Worker invocation owns its own fetch promises.
// Do not store pending promises in module-global maps. A later Worker
// request must not await a promise created by an earlier request.
async function upstoxGet(url, token) {
  if (!token) {
    throw new Error("UPSTOX_TOKEN secret is missing.");
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch (error) {
    const preview = responseText.slice(0, 300).replace(/\s+/g, " ");

    throw new Error(
      `Upstox returned non-JSON response (HTTP ${response.status}). ` +
      `Possible HTML error page or gateway response: ${preview}`
    );
  }

  if (!response.ok || data.status === "error") {
    throw new Error(
      `Upstox API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

function normalizeKey(value) {
  return String(value || "").replace(/:/g, "|").toUpperCase();
}

function istDateDaysAgo(days) {
  const date = new Date(Date.now() - days * 86400000);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));

  return `${p.year}-${p.month}-${p.day}`;
}

function istToday() {
  return istDateDaysAgo(0);
}

// 1st–15th: current calendar month's futures.
// 16th–month-end: next calendar month's futures.
function getTargetCrudeContractMonth() {
  const today = istToday();
  const [year, month, day] = today.split("-").map(Number);

  const target = new Date(Date.UTC(
    year,
    month - 1 + (day >= 16 ? 1 : 0),
    1
  ));

  const targetYear = target.getUTCFullYear();
  const targetMonth = String(target.getUTCMonth() + 1).padStart(2, "0");

  return `${targetYear}-${targetMonth}`;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  let value = ranges.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < ranges.length; i++) {
    value = ((value * (period - 1)) + ranges[i]) / period;
  }

  return value;
}

function calculateVWAP(candles) {
  if (!candles || !candles.length) {
    return {
      value: null,
      candles: 0,
      volume: 0,
      sessionDate: null,
      status: "WAITING FOR SESSION DATA"
    };
  }

  const ordered = [...candles].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  const dateOf = timestamp => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));

  const sessionDate = dateOf(
    ordered[ordered.length - 1].timestamp
  );

  const session = ordered.filter(
    c => dateOf(c.timestamp) === sessionDate
  );

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of session) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const volume = Number(c.volume) || 0;

    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }

  if (!totalVolume) {
    return {
      value: null,
      candles: session.length,
      volume: 0,
      sessionDate,
      status: "VOLUME NOT AVAILABLE"
    };
  }

  return {
    value: totalPV / totalVolume,
    candles: session.length,
    volume: totalVolume,
    sessionDate,
    status: "AVAILABLE"
  };
}

function supertrend(candles, period = 10, multiplier = 3) {
  if (candles.length <= period + 1) return null;

  const trs = [];
  const upper = [];
  const lower = [];
  const finalUpper = [];
  const finalLower = [];
  const trend = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (i === 0) {
      trs.push(c.high - c.low);
    } else {
      const prev = candles[i - 1];

      trs.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      ));
    }

    if (i < period) continue;

    const atrValue = trs.slice(i - period + 1, i + 1)
      .reduce((a, b) => a + b, 0) / period;

    const midpoint = (c.high + c.low) / 2;

    upper[i] = midpoint + multiplier * atrValue;
    lower[i] = midpoint - multiplier * atrValue;

    if (i === period) {
      finalUpper[i] = upper[i];
      finalLower[i] = lower[i];
      trend[i] = c.close >= midpoint ? "BULLISH" : "BEARISH";
      continue;
    }

    const previous = candles[i - 1];

    finalUpper[i] =
      upper[i] < finalUpper[i - 1] ||
      previous.close > finalUpper[i - 1]
        ? upper[i]
        : finalUpper[i - 1];

    finalLower[i] =
      lower[i] > finalLower[i - 1] ||
      previous.close < finalLower[i - 1]
        ? lower[i]
        : finalLower[i - 1];

    if (trend[i - 1] === "BEARISH") {
      trend[i] = c.close > finalUpper[i]
        ? "BULLISH"
        : "BEARISH";
    } else {
      trend[i] = c.close < finalLower[i]
        ? "BEARISH"
        : "BULLISH";
    }
  }

  const last = candles.length - 1;

  return {
    direction: trend[last] || null,
    value: trend[last] === "BULLISH"
      ? finalLower[last]
      : finalUpper[last],
    period,
    multiplier
  };
}

function calculateMACD(values, fastPeriod = 8, slowPeriod = 21, signalPeriod = 5) {
  if (!values || values.length < slowPeriod + signalPeriod + 2) {
    return null;
  }

  const emaSeries = (arr, period) => {
    if (arr.length < period) return [];

    const out = new Array(arr.length).fill(null);

    let value = arr.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

    out[period - 1] = value;

    const k = 2 / (period + 1);

    for (let i = period; i < arr.length; i++) {
      value = arr[i] * k + value * (1 - k);
      out[i] = value;
    }

    return out;
  };

  const eFast = emaSeries(values, fastPeriod);
  const eSlow = emaSeries(values, slowPeriod);

  const macdLine = values.map((_, i) =>
    eFast[i] != null && eSlow[i] != null
      ? eFast[i] - eSlow[i]
      : null
  );

  const valid = macdLine.filter(v => v != null);
  const signalValid = emaSeries(valid, signalPeriod);
  const offset = macdLine.length - valid.length;

  const signalLine = new Array(macdLine.length).fill(null);

  signalValid.forEach((v, i) => {
    if (v != null) signalLine[offset + i] = v;
  });

  const i = macdLine.length - 1;
  const prev = i - 1;

  if (
    macdLine[i] == null ||
    signalLine[i] == null ||
    macdLine[prev] == null ||
    signalLine[prev] == null
  ) {
    return null;
  }

  const histogram = macdLine[i] - signalLine[i];
  const previousHistogram = macdLine[prev] - signalLine[prev];

  return {
    macd: Number(macdLine[i].toFixed(2)),
    signal: Number(signalLine[i].toFixed(2)),
    histogram: Number(histogram.toFixed(2)),
    previousHistogram: Number(previousHistogram.toFixed(2)),
    histogramGrowing: Math.abs(histogram) > Math.abs(previousHistogram),
    histogramDirection:
      histogram > 0 ? "GREEN" : histogram < 0 ? "RED" : "FLAT"
  };
}

// TradingView settings:
// Bands ON, Length 150, Deviation 3.
// Channel plot OFF.
function calculateLRC(values, period = 150, deviationMultiplier = 3) {
  if (!values || values.length < period) return null;

  const slice = values.slice(-period);
  const n = slice.length;

  const meanX = (n - 1) / 2;
  const meanY = slice.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - meanX) * (slice[i] - meanY);
    denominator += (i - meanX) ** 2;
  }

  const slope = denominator ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;

  const residuals = slice.map(
    (v, i) => v - (intercept + slope * i)
  );

  const sd = Math.sqrt(
    residuals.reduce((a, b) => a + b * b, 0) / n
  );

  const mid = intercept + slope * (n - 1);
  const width = sd * deviationMultiplier;

  return {
    mid: Number(mid.toFixed(2)),
    upper: Number((mid + width).toFixed(2)),
    lower: Number((mid - width).toFixed(2)),
    period,
    deviationMultiplier,
    slope: Number(slope.toFixed(4))
  };
}

function evaluateTradeSignal(candles, indicators) {
  if (
    !candles?.length ||
    !indicators?.macd ||
    !indicators?.lrc ||
    indicators.rsi14 == null
  ) {
    return {
      signal: "NEUTRAL",
      color: "amber",
      reason: "Insufficient indicator data for scoring",
      rules: [],
      bullishScore: null,
      bearishScore: null
    };
  }

  const close = candles[candles.length - 1].close;
  const m = indicators.macd;
  const rsiValue = indicators.rsi14;
  const rsiSignal = indicators.rsiSignal;
  const lrc = indicators.lrc;
  const hist = m.histogram;

  const lateBull =
    m.macd > 80 &&
    hist > 0 &&
    Math.abs(hist) < Math.abs(m.previousHistogram);

  const lateBear =
    m.macd < -80 &&
    hist < 0 &&
    Math.abs(hist) < Math.abs(m.previousHistogram);

  function scoreSide(side) {
    const bullish = side === "CE";

    const macdAligned = bullish
      ? m.macd > m.signal
      : m.macd < m.signal;

    const macdZero = bullish
      ? m.macd > 0
      : m.macd < 0;

    const histogramAligned = bullish
      ? hist > 0
      : hist < 0;

    const rsiInPreferredZone = bullish
      ? rsiValue >= 58 && rsiValue <= 70
      : rsiValue >= 30 && rsiValue <= 42;

    const rsiMomentum =
      rsiSignal != null &&
      (bullish ? rsiValue > rsiSignal : rsiValue < rsiSignal);

    const rsiDirectional = bullish
      ? rsiValue > 50
      : rsiValue < 50;

    const lrcAligned = bullish
      ? close > lrc.mid
      : close < lrc.mid;

    const lrcNear =
      Math.abs(close - lrc.mid) <=
      Math.max((lrc.upper - lrc.mid) * 0.25, 0.01);

    const macdPoints =
      macdAligned && macdZero
        ? 25
        : macdAligned || macdZero
          ? 15
          : 0;

    const histogramPoints = histogramAligned ? 15 : 0;

    const rsiPoints = rsiInPreferredZone
      ? 20
      : rsiDirectional
        ? 12
        : 0;

    const rsiSignalPoints = rsiMomentum ? 10 : 0;

    const lrcPoints = lrcAligned
      ? 20
      : lrcNear
        ? 10
        : 0;

    const raw =
      macdPoints +
      histogramPoints +
      rsiPoints +
      rsiSignalPoints +
      lrcPoints;

    const score = Math.round(raw / 90 * 100);

    const rules = [
      {
        name: "MACD direction and zero-line alignment",
        pass: macdAligned && macdZero,
        partial: macdAligned || macdZero,
        points: macdPoints,
        maxPoints: 25,
        detail:
          `MACD ${m.macd}; Signal ${m.signal}; ` +
          `${macdAligned ? "line alignment pass" : "line alignment fail"}; ` +
          `${macdZero ? "zero-line pass" : "zero-line fail"}`
      },
      {
        name: "MACD histogram direction",
        pass: histogramAligned,
        points: histogramPoints,
        maxPoints: 15,
        detail:
          `Histogram ${hist}; ` +
          `${histogramAligned ? "supports" : "does not support"} ${side}`
      },
      {
        name: "RSI range / directional momentum",
        pass: rsiInPreferredZone,
        partial: rsiDirectional,
        points: rsiPoints,
        maxPoints: 20,
        detail:
          `RSI ${rsiValue}; preferred ` +
          `${bullish ? "58–70" : "30–42"}; ` +
          `directional ${rsiDirectional ? "yes" : "no"}`
      },
      {
        name: "RSI versus signal line",
        pass: rsiMomentum,
        points: rsiSignalPoints,
        maxPoints: 10,
        detail: rsiSignal == null
          ? "RSI signal unavailable"
          : `RSI ${rsiValue}; signal ${rsiSignal}`
      },
      {
        name: "Price versus LRC midline",
        pass: lrcAligned,
        partial: lrcNear,
        points: lrcPoints,
        maxPoints: 20,
        detail:
          `Close ${close}; mid ${lrc.mid}; ` +
          `upper ${lrc.upper}; lower ${lrc.lower}`
      }
    ];

    return {
      score,
      rawScore: raw,
      rules,
      components: {
        macdPoints,
        histogramPoints,
        rsiPoints,
        rsiSignalPoints,
        lrcPoints
      }
    };
  }

  const ce = scoreSide("CE");
  const pe = scoreSide("PE");

  let signal = "NEUTRAL";
  let reason = "Neither directional score reached the 70-point threshold.";

  if (lateBull && ce.score >= 70) {
    reason =
      "Bullish setup blocked: MACD is stretched above +80 and its positive histogram is shrinking.";
  } else if (lateBear && pe.score >= 70) {
    reason =
      "Bearish setup blocked: MACD is below -80 and its negative histogram is shrinking.";
  } else if (
    !lateBull &&
    ce.score >= 70 &&
    ce.score > pe.score
  ) {
    signal = "CE";
    reason = "Bullish score reached the entry threshold.";
  } else if (
    !lateBear &&
    pe.score >= 70 &&
    pe.score > ce.score
  ) {
    signal = "PE";
    reason = "Bearish score reached the entry threshold.";
  } else if (ce.score === pe.score) {
    reason = "Bullish and bearish scores are tied; wait for clearer direction.";
  }

  return {
    signal,
    color: signal === "CE"
      ? "green"
      : signal === "PE"
        ? "red"
        : "amber",
    score: signal === "CE"
      ? ce.score
      : signal === "PE"
        ? pe.score
        : Math.max(ce.score, pe.score),
    bullishScore: ce.score,
    bearishScore: pe.score,
    threshold: 70,
    reason,
    rules: signal === "CE"
      ? ce.rules
      : signal === "PE"
        ? pe.rules
        : [],
    bullishRules: ce.rules,
    bearishRules: pe.rules,
    lateExhaustion: lateBull || lateBear,
    close,
    lrcMid: lrc.mid,
    lrcUpper: lrc.upper,
    lrcLower: lrc.lower,
    lrcSettings: {
      length: 150,
      deviation: 3,
      bandsEnabled: true,
      channelPlotEnabled: false
    }
  };
}

// One-pass Wilder RSI series avoids recalculating every candle prefix.
function calculateRsiSeries(values, period = 14) {
  const output = new Array(values.length).fill(null);
  if (!values || values.length <= period) return output;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  output[period] = avgLoss === 0
    ? 100
    : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;

    output[i] = avgLoss === 0
      ? 100
      : 100 - (100 / (1 + avgGain / avgLoss));
  }

  return output;
}

function calculateIndicators(candles) {
  if (!candles || candles.length === 0) {
    return {
      available: false,
      reason: "No completed candles are available.",
      candlesAvailable: 0
    };
  }

  const closes = candles.map(c => c.close);
  const latest = candles[candles.length - 1];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const vwap = calculateVWAP(candles);
  const st = supertrend(candles, 10, 3);
  const macd = calculateMACD(closes, 8, 21, 5);
  const lrc = calculateLRC(closes, 150, 3);

  const rsiValues = calculateRsiSeries(closes, 14)
    .filter(value => value != null);

  const rsiSignal = ema(rsiValues, 5);

  let trend = "NEUTRAL";

  if (ema20 !== null && ema50 !== null && ema200 !== null) {
    if (
      latest.close > ema20 &&
      ema20 > ema50 &&
      ema50 > ema200
    ) {
      trend = "UPTREND";
    } else if (
      latest.close < ema20 &&
      ema20 < ema50 &&
      ema50 < ema200
    ) {
      trend = "DOWNTREND";
    }
  }

  let vwapBias = vwap?.status || "UNAVAILABLE";

  if (vwap?.value != null) {
    vwapBias = latest.close > vwap.value
      ? "ABOVE VWAP"
      : latest.close < vwap.value
        ? "BELOW VWAP"
        : "AT VWAP";
  }

  let rsiBias = "NEUTRAL";

  if (rsi14 !== null) {
    if (rsi14 >= 60) rsiBias = "BULLISH";
    else if (rsi14 <= 40) rsiBias = "BEARISH";
  }

  return {
    available: true,
    completedCandles: candles.length,
    latestCandle: {
      timestamp: latest.timestamp,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: latest.volume,
      oi: latest.oi
    },
    indicators: {
      rsi14: rsi14 === null ? null : Number(rsi14.toFixed(2)),
      rsiBias,
      vwap: vwap?.value != null
        ? Number(vwap.value.toFixed(2))
        : null,
      vwapBias,
      vwapStatus: vwap?.status || "UNAVAILABLE",
      vwapSessionDate: vwap?.sessionDate ?? null,
      vwapSessionCandles: vwap?.candles ?? 0,
      vwapSessionVolume: vwap?.volume ?? 0,
      ema20: ema20 === null ? null : Number(ema20.toFixed(2)),
      ema50: ema50 === null ? null : Number(ema50.toFixed(2)),
      ema200: ema200 === null ? null : Number(ema200.toFixed(2)),
      atr14: atr14 === null ? null : Number(atr14.toFixed(2)),
      supertrend: st,
      macd,
      lrc,
      rsiSignal: rsiSignal === null ? null : Number(rsiSignal.toFixed(2)),
      trend
    }
  };
}

function candleDurationMs(unit, interval) {
  return unit === "hours"
    ? Number(interval) * 3600000
    : Number(interval) * 60000;
}

function normalizeCandles(raw, durationMs) {
  const now = Date.now();

  return (Array.isArray(raw) ? raw : []).map(row => ({
    timestamp: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] || 0),
    oi: Number(row[6] || 0)
  })).filter(c =>
    c.timestamp &&
    Number.isFinite(c.close) &&
    new Date(c.timestamp).getTime() + durationMs <= now
  );
}

async function getCandlesForTimeframe(
  instrumentKey,
  unit,
  interval,
  token
) {
  const toDate = istToday();
  const fromDate = istDateDaysAgo(unit === "hours" ? 89 : 29);
  const durationMs = candleDurationMs(unit, interval);
  const encodedKey = encodeURIComponent(instrumentKey);

  const historicalUrl =
    `https://api.upstox.com/v3/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

  const intradayUrl =
    `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;

  const [historicalResult, intradayResult] = await Promise.allSettled([
    upstoxGet(historicalUrl, token),
    upstoxGet(intradayUrl, token)
  ]);

  const raw = [];

  if (historicalResult.status === "fulfilled") {
    raw.push(...(historicalResult.value.data?.candles || []));
  }

  if (intradayResult.status === "fulfilled") {
    raw.push(...(intradayResult.value.data?.candles || []));
  }

  if (!raw.length) {
    const errors = [historicalResult, intradayResult]
      .filter(x => x.status === "rejected")
      .map(x => x.reason?.message || "Unknown candle API error");

    throw new Error(
      errors.length
        ? errors.join(" | ")
        : "No candle data returned by Upstox."
    );
  }

  const unique = new Map();

  for (const candle of normalizeCandles(raw, durationMs)) {
    unique.set(candle.timestamp, candle);
  }

  return [...unique.values()].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
}

async function getMultiTimeframeAnalysis(instrumentKey, token) {
  const definitions = [
    { key: "5m", label: "5 Min", unit: "minutes", interval: 5 },
    { key: "15m", label: "15 Min", unit: "minutes", interval: 15 },
    { key: "1h", label: "1 Hour", unit: "hours", interval: 1 }
  ];

  const results = await Promise.all(definitions.map(async tf => {
    try {
      const candles = await getCandlesForTimeframe(
        instrumentKey,
        tf.unit,
        tf.interval,
        token
      );

      const analysis = calculateIndicators(candles);
      const latest = candles.length
        ? candles[candles.length - 1]
        : null;

      return [tf.key, {
        label: tf.label,
        available: Boolean(latest),
        completedCandles: candles.length,
        latestCandle: latest ? {
          timestamp: latest.timestamp,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
          volume: latest.volume,
          oi: latest.oi,
          range: Number((latest.high - latest.low).toFixed(2)),
          change: Number((latest.close - latest.open).toFixed(2))
        } : null,
        indicators: analysis.available
          ? analysis.indicators
          : null,
        tradeSignal: analysis.available
          ? evaluateTradeSignal(candles, analysis.indicators)
          : {
              signal: "NEUTRAL",
              color: "amber",
              reason: analysis.reason || "Indicator data unavailable",
              rules: [],
              bullishScore: null,
              bearishScore: null
            },
        reason: analysis.available ? null : analysis.reason
      }];
    } catch (error) {
      return [tf.key, {
        label: tf.label,
        available: false,
        completedCandles: 0,
        latestCandle: null,
        indicators: null,
        tradeSignal: {
          signal: "NEUTRAL",
          color: "amber",
          reason: error.message,
          rules: [],
          bullishScore: null,
          bearishScore: null
        },
        reason: error.message
      }];
    }
  }));

  return Object.fromEntries(results);
}

// OPTION CHAIN
// Use the confirmed Upstox Option Contracts endpoint with the selected
// standard CRUDEOIL futures instrument key. Never use MCX_COM underlying key.
// Select the options expiry independently, then display ATM +/- 10 strikes.
async function getCrudeOptionChain(
  futuresContract,
  futuresPrice,
  token
) {
  const futuresExpiry = futuresContract.expiry;
  const futuresInstrumentKey = futuresContract.instrument_key;

  if (!futuresInstrumentKey) {
    throw new Error("Selected CRUDEOIL futures instrument key is missing.");
  }

  const contractsUrl = new URL(
    "https://api.upstox.com/v2/option/contract"
  );
  contractsUrl.searchParams.set("instrument_key", futuresInstrumentKey);

  const contractsResponse = await upstoxGet(
    contractsUrl.toString(),
    token
  );

  const returnedContracts = Array.isArray(contractsResponse.data)
    ? contractsResponse.data
    : [];

  const options = returnedContracts.filter(item =>
    item.exchange === "MCX" &&
    item.segment === "MCX_FO" &&
    String(item.underlying_symbol || "").toUpperCase() === "CRUDEOIL" &&
    normalizeKey(item.underlying_key) === normalizeKey(futuresInstrumentKey) &&
    (item.instrument_type === "CE" || item.instrument_type === "PE") &&
    item.instrument_key &&
    Number.isFinite(Number(item.strike_price)) &&
    item.expiry &&
    item.expiry >= istToday()
  );

  if (!options.length) {
    return {
      available: false,
      reason:
        "Option Contracts API returned no active standard CRUDEOIL CE/PE contracts for the selected futures contract.",
      futuresExpiry,
      futuresInstrumentKey,
      contractsReturned: returnedContracts.length,
      strikes: []
    };
  }

  const futuresMonth = futuresExpiry.slice(0, 7);
  const expiryDates = [...new Set(options.map(x => x.expiry))].sort();
  const sameMonthExpiries = expiryDates.filter(
    expiry => expiry.slice(0, 7) === futuresMonth
  );

  const optionExpiry = sameMonthExpiries.length
    ? sameMonthExpiries.sort((a, b) =>
        Math.abs(new Date(a) - new Date(futuresExpiry)) -
        Math.abs(new Date(b) - new Date(futuresExpiry))
      )[0]
    : expiryDates.find(expiry => expiry >= istToday());

  const expiryOptions = options.filter(
    item => item.expiry === optionExpiry
  );

  if (!expiryOptions.length) {
    return {
      available: false,
      reason: `No standard CRUDEOIL options found for selected options expiry ${optionExpiry || "N/A"}.`,
      futuresExpiry,
      futuresInstrumentKey,
      optionExpiry: optionExpiry || null,
      contractsReturned: returnedContracts.length,
      strikes: []
    };
  }

  const referencePrice = Number(futuresPrice);

  if (!Number.isFinite(referencePrice)) {
    return {
      available: false,
      reason: "Futures LTP is unavailable; cannot identify ATM strike.",
      futuresExpiry,
      futuresInstrumentKey,
      optionExpiry,
      strikes: []
    };
  }

  const uniqueStrikes = [
    ...new Set(expiryOptions.map(item => Number(item.strike_price)))
  ].sort((a, b) => a - b);

  let atmIndex = 0;
  for (let i = 1; i < uniqueStrikes.length; i++) {
    if (
      Math.abs(uniqueStrikes[i] - referencePrice) <
      Math.abs(uniqueStrikes[atmIndex] - referencePrice)
    ) {
      atmIndex = i;
    }
  }

  const selectedStrikes = uniqueStrikes.slice(
    Math.max(0, atmIndex - 10),
    atmIndex + 11
  );
  const selectedSet = new Set(selectedStrikes);
  const selectedOptions = expiryOptions.filter(
    item => selectedSet.has(Number(item.strike_price))
  );

  // Fetch all contracts in the selected expiry so PCR and max OI are
  // calculated from the full expiry, not just the visible ATM +/- 10.
  const fullExpiryQuoteKeys = [...new Set(
    expiryOptions.map(item => item.instrument_key).filter(Boolean)
  )];
  const quoteEntries = [];

  for (let i = 0; i < fullExpiryQuoteKeys.length; i += 500) {
    const batch = fullExpiryQuoteKeys.slice(i, i + 500);
    const quoteUrl =
      "https://api.upstox.com/v3/market-quote/quotes?instrument_key=" +
      encodeURIComponent(batch.join(","));
    const quoteResponse = await upstoxGet(quoteUrl, token);
    quoteEntries.push(...Object.entries(quoteResponse.data || {}));
  }

  const quoteByKey = new Map();
  const quoteBySymbol = new Map();

  for (const [key, quote] of quoteEntries) {
    quoteByKey.set(normalizeKey(key), quote);
    if (quote.instrument_token) {
      quoteByKey.set(normalizeKey(quote.instrument_token), quote);
    }
    if (quote.symbol) {
      quoteBySymbol.set(quote.symbol, quote);
    }
  }

  function optionQuote(instrument) {
    if (!instrument) return null;

    return quoteByKey.get(normalizeKey(instrument.instrument_key)) ||
      quoteBySymbol.get(instrument.trading_symbol) || null;
  }

  function quoteFields(instrument) {
    if (!instrument) return null;

    const quote = optionQuote(instrument);

    if (!quote) {
      return {
        instrumentKey: instrument.instrument_key,
        tradingSymbol: instrument.trading_symbol,
        ltp: null,
        change: null,
        volume: null,
        oi: null,
        previousOi: null,
        oiChange: null,
        bidPrice: null,
        bidQuantity: null,
        askPrice: null,
        askQuantity: null
      };
    }

    const bid = quote.depth?.buy?.[0] || {};
    const ask = quote.depth?.sell?.[0] || {};
    const oi = quote.oi ?? null;
    const previousOi = quote.previous_oi ?? null;

    return {
      instrumentKey: instrument.instrument_key,
      tradingSymbol: instrument.trading_symbol,
      ltp: quote.last_price ?? null,
      change: quote.net_change ?? null,
      volume: quote.volume ?? null,
      oi,
      previousOi,
      oiChange:
        oi != null && previousOi != null
          ? oi - previousOi
          : null,
      bidPrice: bid.price ?? null,
      bidQuantity: bid.quantity ?? null,
      askPrice: ask.price ?? null,
      askQuantity: ask.quantity ?? null
    };
  }

  const chainRows = selectedStrikes.map(strike => {
    const ce = selectedOptions.find(item =>
      Number(item.strike_price) === strike && item.instrument_type === "CE"
    );

    const pe = selectedOptions.find(item =>
      Number(item.strike_price) === strike && item.instrument_type === "PE"
    );

    return {
      strike,
      ce: quoteFields(ce),
      pe: quoteFields(pe)
    };
  });

  // Full-expiry OI and PCR, including strikes outside the displayed range.
  const fullExpiryRows = uniqueStrikes.map(strike => {
    const ceInstrument = expiryOptions.find(item =>
      Number(item.strike_price) === strike && item.instrument_type === "CE"
    );

    const peInstrument = expiryOptions.find(item =>
      Number(item.strike_price) === strike && item.instrument_type === "PE"
    );

    return {
      strike,
      ce: quoteFields(ceInstrument),
      pe: quoteFields(peInstrument)
    };
  });

  const totalCeOi = fullExpiryRows.reduce(
    (sum, row) => sum + (Number(row.ce?.oi) || 0),
    0
  );

  const totalPeOi = fullExpiryRows.reduce(
    (sum, row) => sum + (Number(row.pe?.oi) || 0),
    0
  );

  const highestCe = fullExpiryRows.reduce((best, row) =>
    row.ce?.oi != null && (!best || row.ce.oi > best.oi)
      ? { strike: row.strike, oi: row.ce.oi }
      : best,
    null
  );

  const highestPe = fullExpiryRows.reduce((best, row) =>
    row.pe?.oi != null && (!best || row.pe.oi > best.oi)
      ? { strike: row.strike, oi: row.pe.oi }
      : best,
    null
  );

  return {
    available: true,
    futuresExpiry,
    futuresInstrumentKey,
    expiry: optionExpiry,
    expirySelection: sameMonthExpiries.length
      ? "Same calendar month as selected futures"
      : "Nearest available future options expiry",
    underlyingPrice: referencePrice,
    atmStrike: uniqueStrikes[atmIndex],
    strikesReturned: chainRows.length,
    contractsReturnedByApi: returnedContracts.length,
    validStandardCrudeOptions: options.length,
    requestedRange: "ATM ± 10 available strikes",
    pcr: totalCeOi > 0
      ? Number((totalPeOi / totalCeOi).toFixed(3))
      : null,
    totalCeOi,
    totalPeOi,
    highestCeOiStrike: highestCe,
    highestPeOiStrike: highestPe,
    oiChangeSource: "Current OI minus previous session OI",
    oiCalculationScope: "Full selected options expiry",
    strikes: chainRows
  };
}

async function getCrudeData(token) {
  if (!token) {
    throw new Error("UPSTOX_TOKEN secret is missing.");
  }

  const searchUrl =
    "https://api.upstox.com/v2/instruments/search" +
    "?query=CRUDE&exchanges=MCX&page_number=1&records=30";

  const searchResponse = await upstoxGet(searchUrl, token);
  const instruments = searchResponse.data || [];

  if (!Array.isArray(instruments)) {
    throw new Error("Unexpected instrument search response.");
  }

  const futures = instruments.filter(item =>
    item.exchange === "MCX" &&
    item.segment === "MCX_FO" &&
    item.instrument_type === "FUT" &&
    item.underlying_symbol === "CRUDEOIL"
  );

  const targetMonth = getTargetCrudeContractMonth();

  const selectedContract = futures
    .filter(item => item.expiry?.startsWith(targetMonth))
    .sort((a, b) =>
      String(a.expiry).localeCompare(String(b.expiry))
    )[0];

  if (!selectedContract) {
    throw new Error(
      `CRUDEOIL futures contract for ${targetMonth} not found in Upstox instrument search.`
    );
  }

  const contracts = [selectedContract];
  const keys = contracts.map(c => c.instrument_key).join(",");

  const quoteUrl =
    "https://api.upstox.com/v3/market-quote/quotes?instrument_key=" +
    encodeURIComponent(keys);

  const quoteResponse = await upstoxGet(quoteUrl, token);
  const quoteData = quoteResponse.data || {};
  const quoteEntries = Object.entries(quoteData);

  const futuresQuote = quoteEntries.find(([key, q]) =>
    normalizeKey(q.instrument_token) ===
      normalizeKey(selectedContract.instrument_key) ||
    normalizeKey(key) === normalizeKey(selectedContract.instrument_key) ||
    q.symbol === selectedContract.trading_symbol
  )?.[1] || null;

  // Start option-chain processing immediately after futures LTP is known.
  // Candle retrieval below runs while this request is in progress.
  const optionChainPromise = getCrudeOptionChain(
    selectedContract,
    futuresQuote?.last_price ?? null,
    token
  ).catch(error => ({
    available: false,
    futuresExpiry: selectedContract.expiry,
    reason: error.message,
    strikes: []
  }));

  function findQuote(contract) {
    const wantedKey = normalizeKey(contract.instrument_key);

    let found = quoteEntries.find(([key, quote]) =>
      normalizeKey(quote.instrument_token) === wantedKey
    );

    if (!found) {
      found = quoteEntries.find(([key]) =>
        normalizeKey(key) === wantedKey
      );
    }

    if (!found) {
      found = quoteEntries.find(([key, quote]) =>
        quote.symbol === contract.trading_symbol
      );
    }

    return found ? found[1] : null;
  }

  const rows = await Promise.all(contracts.map(async contract => {
    const quote = findQuote(contract);

    const quoteData = quote ? {
      quoteFound: true,
      ltp: quote.last_price ?? null,
      change: quote.net_change ?? null,
      open: quote.ohlc?.open ?? null,
      high: quote.ohlc?.high ?? null,
      low: quote.ohlc?.low ?? null,
      volume: quote.volume ?? null,
      oi: quote.oi ?? null
    } : {
      quoteFound: false,
      ltp: null,
      change: null,
      open: null,
      high: null,
      low: null,
      volume: null,
      oi: null
    };

    let timeframeAnalysis;

    try {
      timeframeAnalysis = await getMultiTimeframeAnalysis(
        contract.instrument_key,
        token
      );
    } catch (error) {
      timeframeAnalysis = {
        "5m": { available: false, reason: error.message },
        "15m": { available: false, reason: error.message },
        "1h": { available: false, reason: error.message }
      };
    }

    return {
      contract: contract.trading_symbol,
      expiry: contract.expiry,
      instrumentKey: contract.instrument_key,
      ...quoteData,
      timeframeAnalysis
    };
  }));

  const optionChain = await optionChainPromise;

  return {
    success: true,
    updatedAt: new Date().toISOString(),
    source: "Upstox V3",
    timeframes: ["5m", "15m", "1h"],
    selectionRule:
      "1st–15th: current month; 16th–month-end: next month",
    selectedContractMonth: targetMonth,
    optionChain,
    contracts: rows
  };
}

/* ------------------------------------------------------------------
   NIFTY AND BANKNIFTY DATA
------------------------------------------------------------------- */

const INDEX_CONFIG = {
  NIFTY: {
    name: "NIFTY",
    underlyingKey: "NSE_INDEX|Nifty 50",
    searchQuery: "NIFTY",
    underlyingSymbol: "NIFTY",
    exchange: "NSE",
    segment: "NSE_FO"
  },
  BANKNIFTY: {
    name: "BANKNIFTY",
    underlyingKey: "NSE_INDEX|Nifty Bank",
    searchQuery: "BANKNIFTY",
    underlyingSymbol: "BANKNIFTY",
    exchange: "NSE",
    segment: "NSE_FO"
  }
};

async function getIndexOptionChain(indexName, spotPrice, token) {
  const config = INDEX_CONFIG[indexName];

  if (!config) {
    throw new Error(`Unsupported index: ${indexName}`);
  }

  const contractsUrl = new URL(
    "https://api.upstox.com/v2/option/contract"
  );

  contractsUrl.searchParams.set(
    "instrument_key",
    config.underlyingKey
  );

  const contractResponse = await upstoxGet(
    contractsUrl.toString(),
    token
  );

  const allContracts = Array.isArray(contractResponse.data)
    ? contractResponse.data
    : [];

  const validContracts = allContracts.filter(item =>
    item.exchange === "NSE" &&
    item.segment === "NSE_FO" &&
    String(item.underlying_symbol || "").toUpperCase() === config.underlyingSymbol &&
    normalizeKey(item.underlying_key) === normalizeKey(config.underlyingKey) &&
    ["CE", "PE"].includes(item.instrument_type) &&
    item.instrument_key &&
    Number.isFinite(Number(item.strike_price)) &&
    item.expiry &&
    item.expiry >= istToday()
  );

  if (!validContracts.length) {
    return {
      available: false,
      reason: `No active ${indexName} option contracts found.`,
      contractsReturned: allContracts.length,
      strikes: []
    };
  }

  const expiries = [...new Set(
    validContracts.map(item => item.expiry)
  )].sort();

  const expiry = expiries.find(date => date >= istToday());

  if (!expiry) {
    return {
      available: false,
      reason: `No future expiry found for ${indexName}.`,
      contractsReturned: allContracts.length,
      strikes: []
    };
  }

  const expiryContracts = validContracts.filter(
    item => item.expiry === expiry
  );

  const uniqueStrikes = [...new Set(
    expiryContracts.map(item => Number(item.strike_price))
  )].sort((a, b) => a - b);

  const referencePrice = Number(spotPrice);

  if (!Number.isFinite(referencePrice)) {
    return {
      available: false,
      reason: `Spot/index price unavailable for ${indexName}.`,
      expiry,
      strikes: []
    };
  }

  let atmIndex = 0;

  for (let i = 1; i < uniqueStrikes.length; i++) {
    if (
      Math.abs(uniqueStrikes[i] - referencePrice) <
      Math.abs(uniqueStrikes[atmIndex] - referencePrice)
    ) {
      atmIndex = i;
    }
  }

  const selectedStrikes = uniqueStrikes.slice(
    Math.max(0, atmIndex - 10),
    atmIndex + 11
  );

  const selectedSet = new Set(selectedStrikes);

  const selectedContracts = expiryContracts.filter(
    item => selectedSet.has(Number(item.strike_price))
  );

  const quoteKeys = [...new Set(
    selectedContracts.map(item => item.instrument_key).filter(Boolean)
  )];

  const quoteEntries = [];

  for (let i = 0; i < quoteKeys.length; i += 500) {
    const batch = quoteKeys.slice(i, i + 500);

    const quoteUrl =
      "https://api.upstox.com/v3/market-quote/quotes?instrument_key=" +
      encodeURIComponent(batch.join(","));

    const quoteResponse = await upstoxGet(quoteUrl, token);

    quoteEntries.push(
      ...Object.entries(quoteResponse.data || {})
    );
  }

  function findOptionQuote(instrument) {
    if (!instrument) return null;

    const wanted = normalizeKey(instrument.instrument_key);

    const found = quoteEntries.find(([key, quote]) =>
      normalizeKey(quote.instrument_token) === wanted ||
      normalizeKey(key) === wanted
    ) || quoteEntries.find(([key, quote]) =>
      quote.symbol === instrument.trading_symbol
    );

    return found ? found[1] : null;
  }

  function getQuoteFields(instrument) {
    if (!instrument) return null;

    const quote = findOptionQuote(instrument);

    if (!quote) {
      return {
        available: false,
        instrumentKey: instrument.instrument_key,
        tradingSymbol: instrument.trading_symbol,
        ltp: null,
        change: null,
        volume: null,
        oi: null,
        previousOi: null,
        oiChange: null,
        bidPrice: null,
        bidQuantity: null,
        askPrice: null,
        askQuantity: null,
        lastTradeTime: null,
        quoteUpdateTime: null
      };
    }

    const bid = quote.depth?.buy?.[0] || {};
    const ask = quote.depth?.sell?.[0] || {};

    const oi = quote.oi ?? null;
    const previousOi = quote.previous_oi ?? null;

    return {
      available: true,
      instrumentKey: instrument.instrument_key,
      tradingSymbol: instrument.trading_symbol,
      ltp: quote.last_price ?? null,
      change: quote.net_change ?? null,
      volume: quote.volume ?? null,
      oi,
      previousOi,
      oiChange:
        oi != null && previousOi != null
          ? oi - previousOi
          : null,
      bidPrice: bid.price ?? null,
      bidQuantity: bid.quantity ?? null,
      askPrice: ask.price ?? null,
      askQuantity: ask.quantity ?? null,
      lastTradeTime: normalizeTimestamp(
        quote.last_trade_time
      ),
      quoteUpdateTime: normalizeTimestamp(
        quote.timestamp
      ),
      greeks: quote.option_greeks || null
    };
  }

  const rows = selectedStrikes.map(strike => {
    const ce = selectedContracts.find(item =>
      Number(item.strike_price) === strike &&
      item.instrument_type === "CE"
    );

    const pe = selectedContracts.find(item =>
      Number(item.strike_price) === strike &&
      item.instrument_type === "PE"
    );

    return {
      strike,
      ce: getQuoteFields(ce),
      pe: getQuoteFields(pe)
    };
  });

  // Full-expiry OI and PCR are calculated from the complete option-chain
  // response, not only the ATM +/- 10 displayed strikes.
  const fullChainUrl = new URL(
    "https://api.upstox.com/v2/option/chain"
  );

  fullChainUrl.searchParams.set(
    "instrument_key",
    config.underlyingKey
  );
  fullChainUrl.searchParams.set("expiry_date", expiry);

  const fullChainResponse = await upstoxGet(
    fullChainUrl.toString(),
    token
  );

  const fullChainRows = Array.isArray(fullChainResponse.data)
    ? fullChainResponse.data
    : [];

  const totalCeOi = fullChainRows.reduce(
    (sum, row) => sum + (Number(row.call_options?.market_data?.oi) || 0),
    0
  );

  const totalPeOi = fullChainRows.reduce(
    (sum, row) => sum + (Number(row.put_options?.market_data?.oi) || 0),
    0
  );

  const highestCe = fullChainRows.reduce((best, row) => {
    const oi = Number(row.call_options?.market_data?.oi);

    return Number.isFinite(oi) && (!best || oi > best.oi)
      ? {
          strike: Number(row.strike_price),
          oi
        }
      : best;
  }, null);

  const highestPe = fullChainRows.reduce((best, row) => {
    const oi = Number(row.put_options?.market_data?.oi);

    return Number.isFinite(oi) && (!best || oi > best.oi)
      ? {
          strike: Number(row.strike_price),
          oi
        }
      : best;
  }, null);

  return {
    available: true,
    index: indexName,
    underlyingKey: config.underlyingKey,
    expiry,
    expirySelection: "Nearest available future expiry",
    underlyingPrice: referencePrice,
    atmStrike: uniqueStrikes[atmIndex],
    strikesReturned: rows.length,
    requestedRange: "ATM ± 10 available strikes",
    contractsReturnedByApi: allContracts.length,
    validContracts: validContracts.length,
    fullExpiryStrikeRows: fullChainRows.length,
    pcr: totalCeOi > 0
      ? Number((totalPeOi / totalCeOi).toFixed(4))
      : null,
    totalCeOi,
    totalPeOi,
    highestCeOiStrike: highestCe,
    highestPeOiStrike: highestPe,
    strikes: rows
  };
}

function normalizeTimestamp(value) {
  if (value == null) return null;

  let milliseconds;

  if (typeof value === "number") {
    milliseconds = value > 1e12 ? value : value * 1000;
  } else {
    const parsed = Date.parse(value);
    milliseconds = Number.isNaN(parsed) ? NaN : parsed;
  }

  const date = new Date(milliseconds);

  return {
    raw: value,
    iso: Number.isNaN(date.getTime()) ? null : date.toISOString(),
    parsed: !Number.isNaN(date.getTime())
  };
}

async function getIndexData(indexName, token) {
  const config = INDEX_CONFIG[indexName];

  if (!config) {
    throw new Error(`Unsupported index ${indexName}`);
  }

  const quoteUrl =
    "https://api.upstox.com/v3/market-quote/quotes?instrument_key=" +
    encodeURIComponent(config.underlyingKey);

  const quoteResponse = await upstoxGet(quoteUrl, token);
  const quoteEntries = Object.entries(quoteResponse.data || {});

  const indexQuote = quoteEntries[0]?.[1] || null;
  const spotPrice = indexQuote?.last_price ?? null;

  const optionChainPromise = getIndexOptionChain(
    indexName,
    spotPrice,
    token
  ).catch(error => ({
    available: false,
    reason: error.message,
    strikes: []
  }));

  const timeframePromise = getMultiTimeframeAnalysis(
    config.underlyingKey,
    token
  );

  const [optionChain, timeframeAnalysis] = await Promise.all([
    optionChainPromise,
    timeframePromise
  ]);

  return {
    success: true,
    index: indexName,
    underlyingKey: config.underlyingKey,
    updatedAt: new Date().toISOString(),
    source: "Upstox V3",
    quote: {
      ltp: indexQuote?.last_price ?? null,
      change: indexQuote?.net_change ?? null,
      open: indexQuote?.ohlc?.open ?? null,
      high: indexQuote?.ohlc?.high ?? null,
      low: indexQuote?.ohlc?.low ?? null,
      volume: indexQuote?.volume ?? null,
      oi: indexQuote?.oi ?? null,
      previousClose: indexQuote?.ohlc?.close ?? null
    },
    timeframeAnalysis,
    optionChain
  };
}

async function getAllDashboardData(token) {
  if (!token) {
    throw new Error("UPSTOX_TOKEN secret is missing.");
  }

  // Each instrument is independent. A failure in one does not reject the others.
  const results = await Promise.allSettled([
    getCrudeData(token),
    getIndexData("NIFTY", token),
    getIndexData("BANKNIFTY", token)
  ]);

  const crude = results[0].status === "fulfilled"
    ? results[0].value
    : {
        success: false,
        error: results[0].reason?.message || "Crude Oil data failed"
      };

  const nifty = results[1].status === "fulfilled"
    ? results[1].value
    : {
        success: false,
        index: "NIFTY",
        error: results[1].reason?.message || "NIFTY data failed"
      };

  const banknifty = results[2].status === "fulfilled"
    ? results[2].value
    : {
        success: false,
        index: "BANKNIFTY",
        error: results[2].reason?.message || "BANKNIFTY data failed"
      };

  const instruments = [
    {
      name: "CRUDE OIL",
      data: crude,
      price: crude.contracts?.[0]?.ltp,
      analysis: crude.contracts?.[0]?.timeframeAnalysis
    },
    {
      name: "NIFTY",
      data: nifty,
      price: nifty.quote?.ltp,
      analysis: nifty.timeframeAnalysis
    },
    {
      name: "BANKNIFTY",
      data: banknifty,
      price: banknifty.quote?.ltp,
      analysis: banknifty.timeframeAnalysis
    }
  ];

  const leaders = instruments.map(item => {
    const signal15 = item.analysis?.["15m"]?.tradeSignal;
    const signal1h = item.analysis?.["1h"]?.tradeSignal;

    const score = Number(signal15?.score);

    return {
      instrument: item.name,
      signal: signal15?.signal || "NEUTRAL",
      score: Number.isFinite(score) ? score : null,
      oneHourSignal: signal1h?.signal || "NEUTRAL",
      price: item.price,
      available: Boolean(item.analysis?.["15m"]?.available)
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  return {
    success: true,
    updatedAt: new Date().toISOString(),
    source: "Upstox V3",
    strongestSetup: leaders[0] || null,
    instrumentSignals: leaders,
    instruments: {
      CRUDEOIL: crude,
      NIFTY: nifty,
      BANKNIFTY: banknifty
    }
  };
}

/* ------------------------------------------------------------------
   DASHBOARD HTML
------------------------------------------------------------------- */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Options Trading Dashboard</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:18px;background:#f3f7fc;color:#172033;font-family:Arial,sans-serif}
.container{max-width:1400px;margin:auto}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px}
.header-actions{display:flex;align-items:center;gap:9px}
.refresh-btn{width:32px;height:32px;border:1px solid #cbd9eb;border-radius:8px;background:#fff;color:#24558b;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:19px;line-height:1}
.refresh-btn:hover{background:#edf4fd}
.refresh-btn:disabled{opacity:.55;cursor:wait}
.refresh-btn.spinning span{display:inline-block;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{margin:0;font-size:22px;color:#173b68}
h2{font-size:15px;margin:0 0 10px;color:#173b68}
h3{font-size:13px;margin:14px 0 8px;color:#24558b}
small,.muted{color:#64748b}
.status{background:#e4efff;color:#1456a0;padding:6px 10px;border-radius:20px;font-size:11px;font-weight:bold}
.panel{background:#fff;border:1px solid #dce7f5;border-radius:10px;padding:13px;margin-bottom:13px;box-shadow:0 2px 8px rgba(30,64,110,.05)}
.updated{font-size:11px;color:#64748b;margin-bottom:10px}
.table-wrap{width:100%;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}
th{background:#edf4fd;color:#31557e;text-align:left;font-weight:700}
th,td{padding:8px 9px;border-bottom:1px solid #edf1f7}
td{color:#172033}
.contract{color:#1557a6;font-weight:bold}
.negative,.bearish{color:#c33b3b;font-weight:bold}
.positive,.bullish{color:#16834b;font-weight:bold}
.neutral{color:#8a6416;font-weight:bold}
.error{color:#b42318;font-size:12px}
.section-gap{margin-top:12px}
.signal-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:13px}
.signal-card{position:relative;background:#fff;border:1px solid #dce7f5;border-radius:10px;padding:14px;min-height:108px;box-shadow:0 2px 8px rgba(30,64,110,.05);cursor:help}
.signal-card h3{margin:0 0 9px;font-size:12px;color:#64748b;letter-spacing:.5px}
.signal-pill{display:inline-block;border-radius:7px;padding:7px 15px;font-size:19px;font-weight:800;letter-spacing:.5px}
.signal-ce{background:#e5f7ed;color:#16834b}
.signal-pe{background:#fdeaea;color:#c33b3b}
.signal-neutral{background:#fff4d8;color:#946b12}
.signal-sub{font-size:11px;color:#64748b;margin-top:7px}
.signal-tooltip{display:none;position:absolute;z-index:20;top:calc(100% + 6px);left:0;width:min(390px,90vw);max-height:360px;overflow:auto;background:#172033;color:#fff;border-radius:9px;padding:12px;box-shadow:0 8px 25px rgba(0,0,0,.22);white-space:normal}
.signal-card:hover .signal-tooltip,.signal-card:focus-within .signal-tooltip{display:block}
.signal-tooltip h4{margin:0 0 8px;font-size:12px;color:#fff}
.signal-rule{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.12);font-size:11px}
.signal-rule:last-child{border-bottom:0}
.signal-tooltip small{color:#9fb0c9;font-size:10px}
.signal-sub.bullish{color:#16834b}
.signal-sub.bearish{color:#c33b3b}
.signal-sub.neutral{color:#946b12}
.rule-pass{color:#6ee7a1}
.rule-fail{color:#ff9292}
.rule-na{color:#ffd479}
.signal-empty{border:1px dashed #b8c6d8;background:transparent;box-shadow:none;cursor:default}
.option-summary-card{cursor:default;min-height:108px}
.option-summary-card h3{margin-bottom:8px}
.option-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}
.option-metric-label{display:block;color:#64748b;font-size:10px;margin-bottom:2px}
.option-metric-value{font-size:15px;font-weight:800;color:#172033}
.option-bias{display:inline-block;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:800}
.option-bias.bullish{background:#e5f7ed;color:#16834b}
.option-bias.bearish{background:#fdeaea;color:#c33b3b}
.option-bias.neutral{background:#fff4d8;color:#946b12}
.option-legend{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 10px;font-size:10px;color:#64748b}
.option-legend span{display:inline-flex;align-items:center;gap:4px}
.option-swatch{width:10px;height:10px;border-radius:3px;display:inline-block}
.option-atm-row td{border-top:2px solid #2563eb;border-bottom:2px solid #2563eb;font-weight:700}
.option-atm-strike{background:#dbeafe!important;color:#1d4ed8!important;font-weight:900!important}
.option-itm{background:#f0fdf4}
.option-otm{background:#fff7f7}
.option-support{color:#16834b;font-size:10px;font-weight:800;margin-left:5px}
.option-resistance{color:#c33b3b;font-size:10px;font-weight:800;margin-left:5px}
.option-buildup{display:block;font-size:9px;font-weight:700;margin-top:2px}
.option-buildup.long{color:#16834b}
.option-buildup.short{color:#c33b3b}
.option-buildup.cover{color:#0f766e}
.option-buildup.unwind{color:#a16207}
.option-chain-table td{transition:background .15s ease}
.tabs{display:flex;gap:8px;border-bottom:1px solid #d6e2f0;margin:12px 0 14px;padding-bottom:8px;position:sticky;bottom:0;background:#f3f7fc;z-index:30}
.tab-btn{flex:1;border:1px solid #cbd9eb;border-radius:9px;background:#fff;color:#31557e;padding:12px 8px;font-weight:800;cursor:pointer}
.tab-btn.active{background:#173b68;color:#fff;border-color:#173b68}
.tab-content{display:none}
.tab-content.active{display:block}
.strongest{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.strongest-main{font-size:15px;font-weight:800}
.strongest-meta{font-size:11px;color:#64748b;margin-top:4px}
.instrument-error{padding:12px;background:#fff5f5;color:#b42318;border:1px solid #f2caca;border-radius:8px;font-size:12px}
@media(max-width:700px){
  .option-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .signal-grid{grid-template-columns:1fr}
  .signal-tooltip{position:static;width:100%;margin-top:8px}
  .signal-card:hover .signal-tooltip{display:block}
  body{padding:9px}
  h1{font-size:19px}
  th,td{padding:7px;font-size:11px}
  .tabs{gap:5px}
  .tab-btn{font-size:11px;padding:11px 5px}
}
</style>
</head>
<body>
<div class="container">
<header>
  <div>
    <h1>Options Trading Dashboard</h1>
    <small>Crude Oil · NIFTY · BANKNIFTY · Upstox data</small>
  </div>
  <div class="header-actions">
    <button class="refresh-btn" id="refreshBtn" title="Refresh market data" aria-label="Refresh market data" onclick="loadData(true)"><span>↻</span></button>
    <div class="status">READ ONLY</div>
  </div>
</header>

<div class="panel">
  <h2>STRONGEST SETUP ACROSS INSTRUMENTS</h2>
  <div id="strongestSetup" class="strongest">
    <div>
      <div class="strongest-main">Loading market data...</div>
      <div class="strongest-meta">Comparing 15-minute signals across all three instruments</div>
    </div>
  </div>
</div>

<div class="tabs">
  <button class="tab-btn active" data-tab="crude" onclick="selectTab('crude')">CRUDE OIL</button>
  <button class="tab-btn" data-tab="nifty" onclick="selectTab('nifty')">NIFTY</button>
  <button class="tab-btn" data-tab="banknifty" onclick="selectTab('banknifty')">BANKNIFTY</button>
</div>

<div id="tab-crude" class="tab-content active">
  <div class="updated" id="crudeUpdated">Loading...</div>
  <h2>TRADE SIGNAL</h2>
  <div class="signal-grid" id="crudeSignals"></div>
  <div id="crudeQuotes"></div>
  <div id="crudeAnalysis"></div>
  <div id="crudeError" class="error"></div>
</div>

<div id="tab-nifty" class="tab-content">
  <div class="updated" id="niftyUpdated">Loading...</div>
  <h2>TRADE SIGNAL</h2>
  <div class="signal-grid" id="niftySignals"></div>
  <div id="niftyQuotes"></div>
  <div id="niftyAnalysis"></div>
  <div id="niftyError" class="error"></div>
</div>

<div id="tab-banknifty" class="tab-content">
  <div class="updated" id="bankniftyUpdated">Loading...</div>
  <h2>TRADE SIGNAL</h2>
  <div class="signal-grid" id="bankniftySignals"></div>
  <div id="bankniftyQuotes"></div>
  <div id="bankniftyAnalysis"></div>
  <div id="bankniftyError" class="error"></div>
</div>
</div>

<script>
const fmt = v => v == null ? "--" :
  typeof v === "number"
    ? v.toLocaleString("en-IN",{maximumFractionDigits:2})
    : v;

function biasClass(value){
  const v=String(value??"").toUpperCase();
  if(v.includes("BULL")||v.includes("UPTREND")||v.includes("ABOVE")) return "bullish";
  if(v.includes("BEAR")||v.includes("DOWNTREND")||v.includes("BELOW")) return "bearish";
  return "neutral";
}

function selectTab(tab){
  document.querySelectorAll(".tab-btn").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.tab===tab);
  });
  document.querySelectorAll(".tab-content").forEach(panel=>{
    panel.classList.toggle("active",panel.id==="tab-"+tab);
  });
}

function renderSignalCard(label, entry, higherTimeframeSignal = null) {
  const sig = entry?.tradeSignal || {
    signal: "NEUTRAL",
    rules: [],
    reason: "Signal unavailable"
  };

  const signal = sig.signal || "NEUTRAL";
  const pillClass = signal === "CE"
    ? "signal-ce"
    : signal === "PE"
      ? "signal-pe"
      : "signal-neutral";

  const ruleRows = (title, rules) => {
    if (!rules?.length) return "";

    return '<div class="signal-rule"><b>' + title + '</b><span></span></div>' +
      rules.map(rule => {
        const passed = rule.pass === true;
        const partial = rule.partial === true;
        const cls = passed ? "rule-pass" : partial ? "rule-na" : "rule-fail";
        const status = passed ? "PASS" : partial ? "PARTIAL" : "FAIL";

        return '<div class="signal-rule"><span>' +
          rule.name +
          '<br><small>' + (rule.detail || "") + '</small></span>' +
          '<b class="' + cls + '">' +
          status + ' · ' +
          (rule.points ?? 0) + '/' +
          (rule.maxPoints ?? 0) +
          '</b></div>';
      }).join("");
  };

  let alignment = "";

  if (higherTimeframeSignal) {
    const conflict =
      signal !== "NEUTRAL" &&
      higherTimeframeSignal !== "NEUTRAL" &&
      signal !== higherTimeframeSignal;

    alignment = conflict
      ? '<div class="signal-sub bearish">1H direction disagrees — avoid entry until aligned</div>'
      : "";
  }

  const scoreInfo =
    '<div class="signal-rule"><span>CE score</span><b>' +
    (sig.bullishScore ?? "--") + '/100</b></div>' +
    '<div class="signal-rule"><span>PE score</span><b>' +
    (sig.bearishScore ?? "--") + '/100</b></div>' +
    '<div class="signal-rule"><span>Entry threshold</span><b>70/100</b></div>';

  const breakdown =
    ruleRows("CE scoring · maximum 100", sig.bullishRules) +
    ruleRows("PE scoring · maximum 100", sig.bearishRules);

  const warning = sig.lateExhaustion
    ? '<div class="rule-fail" style="margin-top:8px">Late / exhausted MACD move — fresh entry blocked.</div>'
    : "";

  return '<div class="signal-card" tabindex="0">' +
    '<h3>' + label + '</h3>' +
    '<span class="signal-pill ' + pillClass + '">' + signal + '</span>' +
    '<div class="signal-sub">' +
    (sig.score == null
      ? "Score unavailable"
      : "Leading score: " + sig.score + "/100") +
    ' · Hover or focus for details</div>' +
    alignment +
    '<div class="signal-tooltip">' +
    '<h4>' + label + ' · Weighted signal breakdown</h4>' +
    scoreInfo +
    '<div class="signal-rule"><span>Decision</span><b>' + signal + '</b></div>' +
    '<div class="signal-rule"><span>' +
    (sig.reason || "No clear setup") +
    '</span></div>' +
    breakdown +
    warning +
    '<div class="signal-rule"><span>' +
    'Scoring: MACD 25, histogram 15, RSI 20, RSI signal 10, LRC 20. ' +
    'Scores are normalized to 100.' +
    '</span></div>' +
    '</div></div>';
}

function optionBiasFromPcr(pcr){
  const value=Number(pcr);
  if(!Number.isFinite(value)) return {label:"UNAVAILABLE",cls:"neutral"};
  if(value>=1.2) return {label:"PUT OI DOMINANT",cls:"bullish"};
  if(value<=0.8) return {label:"CALL OI DOMINANT",cls:"bearish"};
  return {label:"BALANCED",cls:"neutral"};
}

function renderOptionSummaryCard(chain){
  if(!chain?.available){
    return '<div class="signal-card option-summary-card"><h3>OPTION CHAIN</h3>' +
      '<span class="signal-pill signal-neutral">UNAVAILABLE</span>' +
      '<div class="signal-sub">' + (chain?.reason || "Option-chain summary unavailable") + '</div></div>';
  }

  const bias=optionBiasFromPcr(chain.pcr);

  return '<div class="signal-card option-summary-card">' +
    '<h3>OPTION CHAIN SUMMARY</h3>' +
    '<div class="option-summary-grid">' +
    '<div><span class="option-metric-label">CE RESISTANCE</span><span class="option-metric-value" style="color:#c33b3b">' + fmt(chain.highestCeOiStrike?.strike) + '</span></div>' +
    '<div><span class="option-metric-label">PCR · FULL EXPIRY</span><span class="option-metric-value">' + fmt(chain.pcr) + '</span></div>' +
    '<div><span class="option-metric-label">PE SUPPORT</span><span class="option-metric-value" style="color:#16834b">' + fmt(chain.highestPeOiStrike?.strike) + '</span></div>' +
    '<div><span class="option-metric-label">ATM STRIKE</span><span class="option-metric-value">' + fmt(chain.atmStrike) + '</span></div>' +
    '</div>' +
    '<div style="margin-top:8px"><span class="option-bias ' + bias.cls + '">' + bias.label + '</span></div>' +
    '<div class="signal-sub">Underlying ' + fmt(chain.underlyingPrice) + ' · Expiry ' + fmt(chain.expiry) + '</div>' +
    '</div>';
}

function optionBuildup(option){
  if(!option || option.change==null || option.oiChange==null) return "";

  const price=Number(option.change);
  const oi=Number(option.oiChange);

  if(!Number.isFinite(price)||!Number.isFinite(oi)||price===0||oi===0) return "";
  if(price>0&&oi>0) return '<span class="option-buildup long">LONG BUILDUP</span>';
  if(price<0&&oi>0) return '<span class="option-buildup short">SHORT BUILDUP</span>';
  if(price>0&&oi<0) return '<span class="option-buildup cover">SHORT COVERING</span>';

  return '<span class="option-buildup unwind">LONG UNWINDING</span>';
}

function renderQuotes(title, quote, contract, expiry){
  const q=quote||{};

  return '<div class="panel">' +
    '<h2>' + title + '</h2>' +
    '<div class="table-wrap"><table><thead><tr>' +
    '<th>Contract</th><th>Expiry</th><th>LTP</th><th>Change</th>' +
    '<th>Open</th><th>High</th><th>Low</th><th>Volume</th><th>OI</th>' +
    '</tr></thead><tbody><tr>' +
    '<td class="contract">' + fmt(contract) + '</td>' +
    '<td>' + fmt(expiry) + '</td>' +
    '<td>' + fmt(q.ltp) + '</td>' +
    '<td class="' + (Number(q.change)>=0?"positive":"negative") + '">' + fmt(q.change) + '</td>' +
    '<td>' + fmt(q.open) + '</td><td>' + fmt(q.high) + '</td><td>' + fmt(q.low) + '</td>' +
    '<td>' + fmt(q.volume) + '</td><td>' + fmt(q.oi) + '</td>' +
    '</tr></tbody></table></div></div>';
}

function renderIndexQuotes(indexName, quote){
  const q=quote||{};

  return '<div class="panel"><h2>' + indexName + ' SPOT QUOTE</h2>' +
    '<div class="table-wrap"><table><thead><tr>' +
    '<th>Index</th><th>LTP</th><th>Change</th><th>Open</th><th>High</th><th>Low</th><th>Volume</th>' +
    '</tr></thead><tbody><tr>' +
    '<td class="contract">' + indexName + '</td>' +
    '<td>' + fmt(q.ltp) + '</td>' +
    '<td class="' + (Number(q.change)>=0?"positive":"negative") + '">' + fmt(q.change) + '</td>' +
    '<td>' + fmt(q.open) + '</td><td>' + fmt(q.high) + '</td><td>' + fmt(q.low) + '</td>' +
    '<td>' + fmt(q.volume) + '</td>' +
    '</tr></tbody></table></div></div>';
}

function renderAnalysis(data){
  const timeframeAnalysis = data || {};
  const timeframes = [
    ["5m","5 MIN"],
    ["15m","15 MIN"],
    ["1h","1 HOUR"]
  ];

  let html = '<div class="panel"><h2>TECHNICAL INDICATORS</h2>' +
    '<div class="table-wrap"><table><thead><tr>' +
    '<th>Indicator</th><th>5 MIN</th><th>15 MIN</th><th>1 HOUR</th>' +
    '</tr></thead><tbody>';

  const rows = [
    ["Latest close", tf => tf.latestCandle?.close],
    ["RSI 14", tf => tf.indicators?.rsi14],
    ["RSI bias", tf => tf.indicators?.rsiBias],
    ["VWAP", tf => tf.indicators?.vwap],
    ["VWAP bias", tf => tf.indicators?.vwapBias],
    ["EMA 20", tf => tf.indicators?.ema20],
    ["EMA 50", tf => tf.indicators?.ema50],
    ["EMA 200", tf => tf.indicators?.ema200],
    ["ATR 14", tf => tf.indicators?.atr14],
    ["Supertrend", tf => tf.indicators?.supertrend?.direction],
    ["Supertrend value", tf => tf.indicators?.supertrend?.value],
    ["MACD", tf => tf.indicators?.macd?.macd],
    ["MACD signal", tf => tf.indicators?.macd?.signal],
    ["MACD histogram", tf => tf.indicators?.macd?.histogram],
    ["LRC mid", tf => tf.indicators?.lrc?.mid],
    ["LRC upper", tf => tf.indicators?.lrc?.upper],
    ["LRC lower", tf => tf.indicators?.lrc?.lower],
    ["Trend", tf => tf.indicators?.trend]
  ];

  for(const [label,getter] of rows){
    html += '<tr><td><b>' + label + '</b></td>';

    for(const [key] of timeframes){
      const tf=timeframeAnalysis[key]||{};
      const value=tf.available ? getter(tf) : null;
      html += '<td class="' + biasClass(value) + '">' + fmt(value) + '</td>';
    }

    html += '</tr>';
  }

  html += '</tbody></table></div></div>';

  for(const [key,label] of timeframes){
    const tf=timeframeAnalysis[key]||{};
    const candle=tf.latestCandle;

    html += '<div class="panel"><h2>' + label + ' LATEST COMPLETED CANDLE</h2>';

    if(!candle){
      html += '<div class="muted">Candle data unavailable: ' + fmt(tf.reason) + '</div>';
    }else{
      html += '<div class="table-wrap"><table><thead><tr>' +
        '<th>Timestamp</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th><th>OI</th>' +
        '</tr></thead><tbody><tr>' +
        '<td>' + fmt(candle.timestamp) + '</td>' +
        '<td>' + fmt(candle.open) + '</td>' +
        '<td>' + fmt(candle.high) + '</td>' +
        '<td>' + fmt(candle.low) + '</td>' +
        '<td>' + fmt(candle.close) + '</td>' +
        '<td>' + fmt(candle.volume) + '</td>' +
        '<td>' + fmt(candle.oi) + '</td>' +
        '</tr></tbody></table></div>';
    }

    html += '</div>';
  }

  return html;
}

function renderOptionChain(chain){
  if(!chain?.available){
    return '<div class="panel"><h2>OPTION CHAIN</h2><div class="instrument-error">' +
      (chain?.reason || "Option chain unavailable") + '</div></div>';
  }

  const rows=chain.strikes||[];
  const atm=Number(chain.atmStrike);

  let html='<div class="panel"><h2>OPTION CHAIN · ' +
    fmt(chain.expiry) + ' · ATM ±10</h2>' +
    '<div class="option-legend">' +
    '<span>ATM highlighted</span><span>Green = ITM CE / OTM PE</span><span>Red = OTM CE / ITM PE</span>' +
    '</div><div class="table-wrap"><table class="option-chain-table">' +
    '<thead><tr>' +
    '<th colspan="5" style="text-align:center">CALL OPTIONS (CE)</th>' +
    '<th rowspan="2">STRIKE</th>' +
    '<th colspan="5" style="text-align:center">PUT OPTIONS (PE)</th>' +
    '</tr><tr>' +
    '<th>LTP</th><th>Change</th><th>Volume</th><th>OI</th><th>Prev OI</th><th>OI Δ</th><th>Bid (Qty)</th><th>Ask (Qty)</th>' +
    '<th>LTP</th><th>Change</th><th>Volume</th><th>OI</th><th>Prev OI</th><th>OI Δ</th><th>Bid (Qty)</th><th>Ask (Qty)</th>' +
    '</tr></thead><tbody>';

  for(const row of rows){
    const ce=row.ce||{};
    const pe=row.pe||{};
    const isATM=Number(row.strike)===atm;
    const ceClass=Number(row.strike)<atm?"option-itm":"option-otm";
    const peClass=Number(row.strike)>atm?"option-itm":"option-otm";

    html+='<tr class="' + (isATM?"option-atm-row":"") + '">' +
      '<td class="' + ceClass + '">' + fmt(ce.ltp) + '</td>' +
      '<td class="' + ceClass + '">' + fmt(ce.change) + '</td>' +
      '<td class="' + ceClass + '">' + fmt(ce.volume) + '</td>' +
      '<td class="' + ceClass + '">' + fmt(ce.oi) + '</td>' +
      '<td class="' + ceClass + '">' + fmt(ce.previousOi) + '</td>' +
      '<td class="' + ceClass + '">' + fmt(ce.oiChange) + optionBuildup(ce) + '</td>' +
      '<td class="' + ceClass + '">' + fmt(ce.bidPrice) + ' (' + fmt(ce.bidQuantity) + ')</td>' +
      '<td class="' + ceClass + '">' + fmt(ce.askPrice) + ' (' + fmt(ce.askQuantity) + ')</td>' +
      '<td class="' + (isATM?"option-atm-strike":"") + '">' + fmt(row.strike) + '</td>' +
      '<td class="' + peClass + '">' + fmt(pe.ltp) + '</td>' +
      '<td class="' + peClass + '">' + fmt(pe.change) + '</td>' +
      '<td class="' + peClass + '">' + fmt(pe.volume) + '</td>' +
      '<td class="' + peClass + '">' + fmt(pe.oi) + '</td>' +
      '<td class="' + peClass + '">' + fmt(pe.previousOi) + '</td>' +
      '<td class="' + peClass + '">' + fmt(pe.oiChange) + optionBuildup(pe) + '</td>' +
      '<td class="' + peClass + '">' + fmt(pe.bidPrice) + ' (' + fmt(pe.bidQuantity) + ')</td>' +
      '<td class="' + peClass + '">' + fmt(pe.askPrice) + ' (' + fmt(pe.askQuantity) + ')</td>' +
      '</tr>';
  }

  html+='</tbody></table></div></div>';

  return html;
}

function renderInstrument(prefix, data, type){
  const errorEl=document.getElementById(prefix+"Error");
  const updatedEl=document.getElementById(prefix+"Updated");

  errorEl.textContent="";

  if(!data?.success){
    errorEl.innerHTML='<div class="instrument-error">' +
      (data?.error || "Unable to load instrument data") +
      '</div>';
    return;
  }

  updatedEl.textContent="Updated: "+new Date(data.updatedAt).toLocaleString("en-IN");

  let analysis;
  let quoteHtml;
  let contract;

  if(type==="CRUDE"){
    contract=data.contracts?.[0];
    analysis=contract?.timeframeAnalysis||{};
    quoteHtml=renderQuotes(
      "FUTURES QUOTES",
      contract,
      contract?.contract,
      contract?.expiry
    );
  }else{
    analysis=data.timeframeAnalysis||{};
    quoteHtml=renderIndexQuotes(type,data.quote);
  }

  const primary15=analysis["15m"];
  const primary1h=analysis["1h"];

  document.getElementById(prefix+"Signals").innerHTML=
    renderSignalCard("15 MIN",primary15,primary1h?.tradeSignal?.signal||null)+
    renderSignalCard("1 HOUR",primary1h)+
    renderOptionSummaryCard(data.optionChain||{});

  document.getElementById(prefix+"Quotes").innerHTML=quoteHtml;

  document.getElementById(prefix+"Analysis").innerHTML=
    renderAnalysis(analysis)+renderOptionChain(data.optionChain||{});
}

function renderStrongestSetup(data){
  const el=document.getElementById("strongestSetup");
  const signals=data.instrumentSignals||[];

  const valid=signals.filter(x=>
    x.available &&
    x.signal!=="NEUTRAL" &&
    x.score!=null &&
    x.oneHourSignal===x.signal
  );

  if(!valid.length){
    el.innerHTML='<div><div class="strongest-main">NO TRADE</div>' +
      '<div class="strongest-meta">No instrument currently has matching 15-minute and 1-hour directional signals. Wait for confirmation.</div></div>';
    return;
  }

  const best=valid[0];
  const cls=best.signal==="CE"?"signal-ce":"signal-pe";

  el.innerHTML='<div><div class="strongest-main">' +
    best.instrument + ' · ' + best.signal +
    '</div><div class="strongest-meta">15-minute score: ' +
    fmt(best.score) + '/100 · 1-hour signal: ' +
    fmt(best.oneHourSignal) + ' · Underlying: ' +
    fmt(best.price) +
    '</div></div><span class="signal-pill ' + cls + '">' +
    best.signal + '</span>';
}

async function loadData(manual=false){
  const refreshBtn=document.getElementById("refreshBtn");
  const strongest=document.getElementById("strongestSetup");

  if(refreshBtn){
    refreshBtn.disabled=true;
    refreshBtn.classList.add("spinning");
  }

  try{
    const response=await fetch(
      "/api/all-data?refresh="+Date.now(),
      {cache:"no-store"}
    );

    const responseText=await response.text();
    let data;

    try{
      data=JSON.parse(responseText);
    }catch(error){
      throw new Error(
        "Worker returned non-JSON response. HTTP "+
        response.status+". Response: "+
        responseText.substring(0,250).replace(/\s+/g," ")
      );
    }

    if(!response.ok||!data.success){
      throw new Error(data.error||"Unable to fetch dashboard data");
    }

    renderStrongestSetup(data);

    const instruments=data.instruments||{};

    renderInstrument("crude",instruments.CRUDEOIL,"CRUDE");
    renderInstrument("nifty",instruments.NIFTY,"NIFTY");
    renderInstrument("banknifty",instruments.BANKNIFTY,"BANKNIFTY");

  }catch(error){
    strongest.innerHTML='<div class="instrument-error">'+error.message+'</div>';
  }finally{
    if(refreshBtn){
      refreshBtn.disabled=false;
      refreshBtn.classList.remove("spinning");
    }
  }
}

loadData();
setInterval(()=>loadData(false),60000);
</script>
</body>
</html>`;