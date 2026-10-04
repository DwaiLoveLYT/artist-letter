#!/usr/bin/env bash
# ============================================================
#  云端巡检 —— 只做一件事：回答「客户的订单管道现在还通吗」
# ============================================================
#
# 这个脚本**跑在 GitHub 的服务器上**，和 DWAY 的电脑开不开机、有没有休眠
# 没有任何关系。这是它存在的唯一理由：
# WorkBuddy 里的定时任务依赖本机，电脑睡了就不触发；
# 而「后端挂了 / 前端指着旧地址」这两种故障**恰恰最容易发生在半夜**。
#
# 设计上刻意做到三件事：
#   ① **不需要任何密钥**。只打公开的 GET，所以没有 secret 要维护、也不会泄漏。
#   ② **不需要维护第二份地址副本**。后端地址是**从线上 cloud.js 里读出来的** ——
#      于是「前端还指着旧地址、后端已经搬走」这个最致命的状态，在这里必然报红。
#      如果改成在这里写死一个地址，那这条检查就废了（它会一直检查那个写死的地址）。
#   ③ **失败要吵**。退出码非 0 → Actions 任务失败 → GitHub 给仓库主人发邮件；
#      调用方（workflow）还会开一个 Issue。静默的成功是没用的，静默的失败更糟。
#
# 九项检查，按「客户会先撞到哪个」排序：
#   ① 客户页同步脚本取得到        ② 能读出后端地址
#   ③ 后端活着且是我们的服务      ④ 两个页面能打开
#   ⑤ 线上前端还带着新功能标记    ⑥ 静态资源齐全（**含收款码**）
#   ⑦ 后端**真的**连得上数据仓库  ⑧ 下单接口的路由与校验在跑
#   ⑨ 数据仓库**没有**被公开
#
# ⑥⑦⑧⑨ 是后补的。补它们的原因很一致：**前五条全绿、但客户依然办不成事**的
# 几种形态，原来的检查一条都看不见。
#
# 用法：bash tools/patrol.sh
set -uo pipefail

SITE="https://dwailovelyt.github.io/artist-letter/h5"
DATA_RAW="https://raw.githubusercontent.com/DwaiLoveLYT/artist-letter-data/main"
FAIL=0

note(){ printf '%s\n' "$*"; }
bad(){ FAIL=1; printf '❌ %s\n' "$*"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 统一的取文件：超时 30 秒、失败重试 2 次（GitHub Pages / 沙箱偶尔抽一下，不该直接判死）
get(){ # get <url> <输出文件>  → 回显 HTTP 码
  curl -sS -o "$2" -w '%{http_code}' --max-time 30 --retry 2 --retry-delay 3 "$1" 2>/dev/null || echo 000
}

note "巡检时间：$(date -u '+%Y-%m-%d %H:%M UTC')"
note "站点：$SITE"
note ""

# ---------- ① 客户页同步脚本必须取得到 ----------
code="$(get "$SITE/cloud.js" "$tmp/cloud.js")"
if [ "$code" != "200" ]; then
  bad "客户页同步脚本取不到（HTTP $code）：$SITE/cloud.js"
  note "    这一条断了，所有客户的页面都连不上后端 —— 最高优先级。"
fi

# ---------- ② 从**线上文件本身**读出后端地址 ----------
API=""
if [ -s "$tmp/cloud.js" ]; then
  API="$(sed -nE "s/.*CLOUD_BASE_DEFAULT[[:space:]]*=[[:space:]]*'([^']+)'.*/\1/p" "$tmp/cloud.js" | head -1)"
fi
if [ -z "$API" ]; then
  bad "读不出 cloud.js 里的 CLOUD_BASE_DEFAULT（文件结构变了？）"
  note "    这本身就是要立刻看的事：读不出地址 = 页面拿不到后端地址。"
else
  note "线上前端指向的后端：$API"

  # ---------- ③ 后端必须活着，而且必须是**我们的**服务 ----------
  #
  # 只看 HTTP 200 是不够的：历史上作废的地址回的是 HTTP 400 + 一张别人的营销页；
  # 但状态码是**别人的服务器**说了算 —— 哪天它改成 200，只看状态码就会把
  # 「完全不是我们服务的页面」判成活地址。所以必须验 service 字段。
  hc="$(get "$API/api/health" "$tmp/health.json")"
  if [ "$hc" != "200" ]; then
    bad "后端没有回应（HTTP $hc）：$API/api/health"
    note "    沙箱可能被回收了。需要重新发布后端 —— 注意：重发很可能会换地址，"
    note "    换地址后必须走完「set-endpoint → push-github → wait-cdn → 更新各处地址副本」六步。"
  elif ! grep -q '"service":"artist-letter-api"' "$tmp/health.json"; then
    bad "这个地址回的不是我们的服务，内容：$(head -c 160 "$tmp/health.json" | tr -d '\n')"
  else
    note "后端健康：$(head -c 220 "$tmp/health.json" | tr -d '\n')"
    # ⚠ health 里的 orders 是「内存里的单数、没有对账」，不是权威值，别拿它判断台账有几单。
    #    loaded:false 只代表冷启动中（沙箱空闲会被回收），再请求一次就好，不是故障。
  fi
fi

# ---------- ④ 两个页面必须能打开 ----------
for p in "" "admin/"; do
  c="$(get "$SITE/$p" "$tmp/page.html")"
  [ "$c" = "200" ] || bad "页面打不开（HTTP $c）：$SITE/$p"
done

# ---------- ⑤ 线上前端必须还带着「已经上线了」的功能标记 ----------
#
# 这一条挡的是「线上被回滚成旧版」。那种事**不会报错**：
# 客户只是少了几个状态、看不到信封照片、视频又打不开了 —— 而你不知道。
# 每个标记都对应一次真实的客户反馈，删任何一个都要有理由。
chk(){ # chk <仓库内相对路径> <必须存在的字符串> <人话>
  local f="$1" needle="$2" human="$3"
  local c
  c="$(get "$SITE/$f" "$tmp/f")"
  if [ "$c" != "200" ]; then bad "取不到 $f（HTTP $c）"; return; fi
  if ! grep -qF -- "$needle" "$tmp/f"; then
    bad "线上 $f 里少了「$human」—— 线上很可能是旧版"
  fi
}
chk app.js         "key:'drawn'"       "「绘制完成 / 准备寄出」两个状态"
chk app.js         "env-pair"          "信封正反面并排展示"
chk app.js         'loading="lazy"'    "图片按需加载"
chk app.js         "img-loaded"        "骨架占位动画到位后停止"
chk admin/admin.js "grabPoster"        "上传视频时自动抠封面帧"
chk admin/admin.js "SHRINK_LADDER"     "图片按体积压缩"
chk admin/admin.js "slot: 'front'"     "三个固定上传位（信封正面/反面/投递视频）"

# ---------- ⑥ 静态资源必须齐全，收款码必须**真的是一张图** ----------
#
# 为什么后补：原来只查了 app.js / admin.js 里的功能标记，**没查 CSS、没查图片**。
# 资源 404 不会让前面任何一条变红，但客户看到的是「没样式的裸页面」，
# 或者更糟 —— **收款码裂图，等于收不到钱**。
for f in "style.css" "admin/admin.css"; do
  c="$(get "$SITE/$f" "$tmp/asset")"
  [ "$c" = "200" ] || bad "静态资源取不到（HTTP $c）：$SITE/$f —— 页面会退化成没样式的裸页"
done

payc="$(get "$SITE/images/pay-qr.jpg" "$tmp/pay.jpg")"
if [ "$payc" != "200" ]; then
  bad "收款码取不到（HTTP $payc）：$SITE/images/pay-qr.jpg —— 客户看不到二维码 = 收不到钱"
else
  # 只验 200 挡不住「返回一张 200 的错误页」。所以再看两件事：
  # 体积（真图 100KB 上下，错误页通常几百字节）+ JPEG 魔数 FF D8。
  psz="$(wc -c < "$tmp/pay.jpg" | tr -d ' ')"
  pmagic="$(head -c 2 "$tmp/pay.jpg" | od -An -tx1 | tr -d ' \n')"
  if [ "$pmagic" != "ffd8" ]; then
    bad "收款码不是一张 JPEG（魔数 $pmagic，${psz} 字节）—— 很可能被替换成了别的文件"
  elif [ "$psz" -lt 3000 ]; then
    bad "收款码只有 ${psz} 字节，不像一张真图（错误页/占位图？）"
  fi
fi

# ---------- ⑦ 后端**真的**连得上数据仓库吗（穿透检查）----------
#
# 挡的是最阴的一种故障：后端进程活着、health 全绿、页面正常，
# **但它拿不到 GitHub 上的订单台账**（令牌被撤销 / 仓库改名 / GitHub 抽风 / 配额爆了）。
# 此时客户下的单收不到、查单全挂 —— 而 ①~⑥ 每一条都会说「一切正常」。
#
# 做法：查一个**格式合法但绝不存在**的订单号（1999 年，不可能有单）。
# 读一下 server.js 就知道它怎么区分：
#   404 not_found            → 后端**真的读到了** GitHub，只是没这一单 → 正常
#   503 upstream_unavailable → 后端连不上仓库 → **报警，这是关键信号**
#   429                      → 被限流，不判（GitHub runner 的出口 IP 是共享的）
if [ -n "$API" ]; then
  pc="$(get "$API/api/order/AL19990101ZZZZZZ?phone=0000" "$tmp/lookup.json")"
  lb="$(head -c 200 "$tmp/lookup.json" | tr -d '\n')"
  case "$pc" in
    404) : ;;  # 正常
    503) bad "后端连不上数据仓库（HTTP 503 upstream_unavailable）—— 订单收不到、查单全挂，而 health 是绿的" ;;
    429) note "  查单被限流（HTTP 429），这一条跳过不判" ;;
    *)   bad "查单接口异常（HTTP $pc）：$lb" ;;
  esac
fi

# ---------- ⑧ 下单接口的路由与校验在跑吗 ----------
#
# 只发一个**空 body**：后端在 cleanOrder() 就会把它拒掉（400 bad_order），
# **一个字节都不会写进台账**（已实测：跑前跑后台账单数不变，8 → 8）。
# 它证明的是「路由在、body 能解析、校验逻辑在跑」—— 而 health 绿并不能证明这些。
#
# ⚠ 副作用（预期，不是故障）：/api/logs 里会多一条来自 GitHub 出口 IP 的
#   「结构不合规」拒绝记录。看到它别当成有人在攻击。
#   （频率跟着 cron 走：cron 改多久一次，这条留痕就多久一条。）
if [ -n "$API" ]; then
  oc="$(curl -sS -o "$tmp/order.json" -w '%{http_code}' --max-time 30 --retry 2 --retry-delay 3 \
        -X POST -H 'Content-Type: application/json' -d '{}' "$API/api/order" 2>/dev/null || echo 000)"
  ob="$(head -c 200 "$tmp/order.json" | tr -d '\n')"
  case "$oc" in
    400) : ;;  # 正常：被结构校验挡下
    429) note "  下单接口被限流（HTTP 429），这一条跳过不判" ;;
    *)   bad "下单接口异常（HTTP $oc）：$ob —— 路由或校验可能坏了，客户会下不了单" ;;
  esac
fi

# ---------- ⑨ 数据仓库**绝不能**被公开 ----------
#
# 里面是客户的真实姓名 / 手机号 / 收信地址。一旦被改成 public，全世界都能下载 ——
# 这是这个生意最严重的事故，而且**没有任何症状**：站点照常、订单照常，只有你被蒙在鼓里。
#
# 用 raw.githubusercontent（CDN，不受 API 限流影响）去取一个**确实存在**的数据文件：
#   404 → 私有，正确
#   200 → **公开了** → 立刻报警
#   其他（网络问题）→ 不判，别误报
prc="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 --retry 2 --retry-delay 3 \
       "$DATA_RAW/data/deleted.json" 2>/dev/null || echo 000)"
if [ "$prc" = "200" ]; then
  bad "数据仓库被公开了！客户的姓名/手机/收信地址任何人可下载 —— 立刻去 GitHub 把 artist-letter-data 改回 private"
elif [ "$prc" != "404" ]; then
  note "  数据仓库私有性检查拿不到确定结果（HTTP $prc），跳过不判（不是故障）"
fi

# ---------- 汇总 ----------
note ""
if [ "$FAIL" = "0" ]; then
  note "✅ 巡检通过：后端活着、连得上数据仓库、前端指着对的地方、页面和收款码都在、该有的功能都在。"
else
  note "⚠️ 上面有 ❌ —— 客户的订单管道可能已经出问题了。"
  note "   下一步：打开 WorkBuddy，找「订单同步系统巡检」那条记录，让它做深度检查与修复。"
fi
exit "$FAIL"
