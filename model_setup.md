# NeuralWatt — DeepSeek V4 Flash

Use NeuralWatt directly through its OpenAI-compatible API (no custom cloud proxy).

```text
Provider: NeuralWatt
Base URL: https://api.neuralwatt.com/v1
Model: deepseek-v4-flash
API key environment variable: NEURALWATT_API_KEY
```

Set your key locally; do not commit it:

```bash
export NEURALWATT_API_KEY="sk-9c10e2ce189c0a235ef5d4fa207bdfb2fe01909fe47a8cf5fba41c099c997d27"
```

Test the connection:

```bash
curl https://api.neuralwatt.com/v1/chat/completions \
  -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Reply with OK"}]
  }'
```

Python/OpenAI SDK:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://api.neuralwatt.com/v1",
    api_key=os.environ["NEURALWATT_API_KEY"],
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Reply with OK"}],
)
print(response.choices[0].message.content)
```

Agent rule: read the API key only from `NEURALWATT_API_KEY`; never print, log, or write it into source files.
