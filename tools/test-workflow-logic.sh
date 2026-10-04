#!/usr/bin/env bash
# ============================================================
#  验证 patrol.yml 里「开单去重」那段 shell 的分支真的对
# ============================================================
#
# 为什么需要它：把定时从 6 小时改成 1 小时后，如果去重坏了，
# 一次故障会开出 24 张单子 —— 报警变成噪音，就等于没有报警。
# 而「宁可重复也不要漏」这条底线，也必须被验证，不能靠读代码相信。
#
# 关键：这段脚本是**直接从 patrol.yml 里抽出来的**，不是抄一份。
# 抄一份的话，改了 yml 忘了改测试，测试就变成了自欺欺人。
#
# 用法：bash tools/test-workflow-logic.sh
set -uo pipefail

cd "$(dirname "$0")/.."
YML=".github/workflows/patrol.yml"
PY="C:/Users/Administrator/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe"
[ -f "$PY" ] || PY="C:/Users/Administrator/.workbuddy-ai/binaries/python/envs/default/bin/python"

D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT

# 从 yml 里把「出问题时开一张单子」那一步的 run 抽出来
"$PY" - "$YML" "$D/step.sh" <<'PYEOF'
import sys, yaml
src, out = sys.argv[1], sys.argv[2]
d = yaml.safe_load(open(src, encoding='utf-8'))
steps = d['jobs']['patrol']['steps']
step = [s for s in steps if '出问题时开一张单子' in (s.get('name') or '')][0]
open(out, 'w', encoding='utf-8').write(step['run'])
print('已从 yml 抽出该步骤，%d 行' % len(step['run'].splitlines()))
PYEOF

[ -s "$D/step.sh" ] || { echo "❌ 没能从 yml 里抽出脚本"; exit 1; }

# 🔴 关键一步：模拟 Actions runner 的表达式替换。
#
# GitHub 在执行 run: 之前，会先把 `${{ ... }}` 换成真实值 —— **bash 根本看不到它们**。
# 本地直接跑这段脚本，bash 会把 `${{ github.server_url }}` 当成 `${...}` 展开，
# 报 "bad substitution"。那是**假故障**，不是 yml 写错了。
# 不先替换就跑，测的是一个不存在的问题，而且会把人往错的方向带。
sed -E 's/\$\{\{[^}]*\}\}/https:\/\/example.invalid/g' "$D/step.sh" > "$D/step.run.sh"

# 造一个假的 gh：行为由 FAKE_MODE 决定
mkdir -p "$D/bin"
cat > "$D/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
case "$1 $2" in
  "issue list")
    case "${FAKE_MODE:-zero}" in
      zero)  echo "0" ;;                       # 没有未关闭的单子 → 应该开单
      some)  echo "2" ;;                       # 已经有 2 张     → 应该跳过
      fail)  exit 1 ;;                         # 查询失败        → 应该照样开单
      empty) echo "" ;;                        # 返回空          → 应该照样开单
    esac ;;
  "issue create")
    echo "CREATE_CALLED" ;;
esac
GHEOF
chmod +x "$D/bin/gh"

PASS=0; FAIL=0
run_case(){ # run_case <模式> <期望: create|skip> <人话>
  local mode="$1" want="$2" human="$3"
  local out
  out="$(PATH="$D/bin:$PATH" FAKE_MODE="$mode" bash "$D/step.run.sh" 2>&1)"
  local got="skip"
  printf '%s' "$out" | grep -q "CREATE_CALLED" && got="create"
  if [ "$got" = "$want" ]; then
    printf '  ✅ %s → %s\n' "$human" "$( [ "$want" = create ] && echo '开了单' || echo '跳过，不重复开' )"
    PASS=$((PASS+1))
  else
    printf '  ❌ %s → 期望 %s，实际 %s\n' "$human" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/       /'
    FAIL=$((FAIL+1))
  fi
}

printf '\n== 开单去重的四个分支 ==\n'
run_case zero  create "没有未关闭的单子"
run_case some  skip   "已经有 2 张未关闭的单子"
run_case fail  create "查询失败（宁可重复，不可漏报）"
run_case empty create "查询返回空（宁可重复，不可漏报）"

# ── 第二步：「检查哨兵自己」那一步调的脚本，文件真的存在吗 ──────────
#
# 这一步 2026-10-05 才加。它最容易坏的方式不是逻辑写错，而是
# **workflow 里写了一个仓库里并不存在的路径** —— 那样每次跑都会
# 在这一步失败，于是**每一轮都开一张单子**，报警立刻变成噪音。
# 而 GitHub 不会在保存时告诉你路径不存在（它也不知道）。
# 所以这里静态验一下：yml 里 run: 调到的每个 bash 脚本，仓库里都在。
printf '\n== workflow 里 run: 调到的脚本都存在吗 ==\n'
"$PY" - "$YML" <<'PYEOF'
import sys, os, re, yaml
src = sys.argv[1]
d = yaml.safe_load(open(src, encoding='utf-8'))
steps = d['jobs']['patrol']['steps']
root = os.getcwd()
bad = 0
for s in steps:
    cmd = s.get('run') or ''
    for m in re.finditer(r'bash\s+(\S+\.sh)', cmd):
        p = m.group(1)
        if os.path.isfile(p):
            print('  ✅ %s  （%s）' % (p, s.get('name')))
        else:
            print('  ❌ %s 不存在（%s）—— 这一步每次都会失败' % (p, s.get('name')))
            bad = 1
if bad:
    raise SystemExit(1)
PYEOF
[ $? -eq 0 ] || FAIL=$((FAIL+1))
PASS=$((PASS+1))

printf '\n== 汇总 ==\n  通过 %d，失败 %d\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ] || { printf '\n⚠️ 去重逻辑有问题 —— 修好再上线。\n'; exit 1; }
printf '\n✅ 去重逻辑正确：正常时不刷屏，异常时一定叫得出来。\n'
