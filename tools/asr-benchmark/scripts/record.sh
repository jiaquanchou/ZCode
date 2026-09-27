#!/bin/bash
# 录制真实语音集（供 benchmark）。需要 sox。
# 用法：bash tools/asr-benchmark/scripts/record.sh [类别]
# 类别：general_zh / zh_en_mix / coding_terms / long_sentence / noisy / silence
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
AUDIO_DIR="$DIR/audio"
REFS="$DIR/references.jsonl"
CATEGORY="${1:-general_zh}"
mkdir -p "$AUDIO_DIR"

# 取下一个序号
NEXT_ID=$(ls "$AUDIO_DIR"/*.wav 2>/dev/null | wc -l | tr -d ' ')
NEXT_ID=$((NEXT_ID + 1))
ID=$(printf "%03d" "$NEXT_ID")
WAV="$AUDIO_DIR/$ID.wav"

echo ">>> 类别：$CATEGORY | 编号：$ID"
echo ">>> 开始录音（16k mono），说话完毕按 Ctrl+C 停止…"
sox -d -r 16000 -c 1 -b 16 "$WAV"
echo "<<< 已保存 $WAV"

read -r -p "参考文本（ground truth）：" TEXT
read -r -p "技术词（逗号分隔，可空）：" TERMS_RAW
TERMS_JSON=$(echo "$TERMS_RAW" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | sed 's/^/"/;s/$/"/' | paste -sd, -)

python3 - "$ID" "$WAV" "$TEXT" "$TERMS_JSON" "$CATEGORY" "$REFS" <<'PYEOF'
import json, sys, os
id_, wav, text, terms_json, category, refs_path = sys.argv[1:7]
terms = [t.strip('"') for t in terms_json.split(',') if t.strip('"')] if terms_json else []
rel = os.path.basename(wav)
line = json.dumps({"id": id_, "audio": rel, "text": text, "terms": terms, "category": category}, ensure_ascii=False)
with open(refs_path, "a", encoding="utf-8") as f:
    f.write(line + "\n")
print(">>> 已追加 references.jsonl:", line)
PYEOF
