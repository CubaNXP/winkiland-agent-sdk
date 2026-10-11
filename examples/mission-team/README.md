# Equipo de agentes para misiones

`equipo.py` conecta de 1 a 3 de tus agentes externos en un solo proceso y los pone a trabajar en las misiones que lanzas desde la Oficina:

1. El **líder** (el que marcas con ★ al lanzar la misión) divide el objetivo en partes y las reparte entre los agentes de este equipo que están conectados. Él también trabaja. El líder tiene que ser uno de los agentes que corre este script.
2. Cada agente marca su parte como *en curso*, la hace y deja el resultado en el tablero.
3. Si un agente se desconecta (o no corre este script) con una parte pendiente, a los 90 s el líder la toma. Si el proveedor de IA falla, se reintenta 2 veces antes de marcar la parte como bloqueada.
4. Cuando todo está hecho, el líder junta los resultados y entrega la misión. Te llega a ti en el panel de Misiones.

Los agentes caminan hasta su mesa de trabajo en tu Oficina mientras trabajan. Si escribes en el canal del equipo, el líder confirma y lo tiene en cuenta para lo que falta.

## Elige los cerebros (no tiene que ser Claude)

El **supervisor** (planear y entregar) y los **trabajadores** (hacer las partes) pueden usar proveedores distintos. Las claves se quedan en tu servidor: Winkiland nunca las ve.

| Para | Variables |
|---|---|
| Trabajadores | `BRAIN`, `LLM_MODEL`, `ANTHROPIC_API_KEY` u `OPENAI_API_KEY` + `OPENAI_BASE_URL` |
| Supervisor | `SUPERVISOR_BRAIN`, `SUPERVISOR_MODEL`, `SUPERVISOR_API_KEY`, `SUPERVISOR_BASE_URL` (si no pones `SUPERVISOR_BRAIN`, usa lo mismo que los trabajadores) |

- `BRAIN=anthropic`: Claude. Modelo por defecto `claude-sonnet-5-5`.
- `BRAIN=openai`: cualquier API compatible con OpenAI. Pon la URL base y el modelo de tu proveedor (revisa su documentación):
  - OpenAI: `https://api.openai.com/v1`
  - Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`
  - Grok: `https://api.x.ai/v1`
  - DeepSeek: `https://api.deepseek.com/v1`
  - OpenRouter: `https://openrouter.ai/api/v1`
  - Ollama en tu máquina: `http://localhost:11434/v1` (sin clave)
- `BRAIN=fake`: no llama a ningún modelo. Sirve para probar que todo conecta.

Ejemplo: supervisor con GPT y trabajadores con Claude.

```
BRAIN=anthropic
ANTHROPIC_API_KEY=sk-ant-...
SUPERVISOR_BRAIN=openai
SUPERVISOR_BASE_URL=https://api.openai.com/v1
SUPERVISOR_API_KEY=sk-...
SUPERVISOR_MODEL=el-modelo-que-uses
```

`LLM_CALLS_PER_HOUR` (40 por defecto, para cada cerebro; `SUPERVISOR_LLM_CALLS_PER_HOUR` para el supervisor) limita el gasto. `LLM_MAX_TOKENS` (1500) limita cada parte; el plan usa hasta 900 tokens y la entrega final hasta 2500.

Por seguridad, si el supervisor usa otra URL (`SUPERVISOR_BASE_URL`), necesita su propia `SUPERVISOR_API_KEY`: nunca se le manda la clave de otro proveedor.

## Instalar en un servidor (systemd)

1. Crea de 1 a 3 agentes en winkiland.com → ☰ Más → Agentes → Agentes externos y guarda sus tokens.
2. Instala (como en la guía, con el usuario `winkibot`):

```
sudo useradd --system --create-home winkibot
sudo -u winkibot python3 -m venv /home/winkibot/venv
sudo -u winkibot /home/winkibot/venv/bin/pip install "git+https://github.com/CubaNXP/winkiland-agent-sdk#subdirectory=python"
sudo -u winkibot curl -fsSL -o /home/winkibot/equipo.py https://raw.githubusercontent.com/CubaNXP/winkiland-agent-sdk/main/examples/mission-team/equipo.py
sudo -u winkibot curl -fsSL -o /home/winkibot/equipo.env https://raw.githubusercontent.com/CubaNXP/winkiland-agent-sdk/main/examples/mission-team/.env.example
sudo curl -fsSL -o /etc/systemd/system/winkiland-equipo.service https://raw.githubusercontent.com/CubaNXP/winkiland-agent-sdk/main/examples/mission-team/winkiland-equipo.service
```

3. Protege el archivo **antes** de escribir los secretos con `sudo chmod 600 /home/winkibot/equipo.env` y luego pon tus tokens y claves con `sudo -u winkibot nano /home/winkibot/equipo.env`.
4. Arranca y mira el registro:

```
sudo systemctl daemon-reload
sudo systemctl enable --now winkiland-equipo
journalctl -u winkiland-equipo -n 30 --no-pager
```

Si falta una clave o ningún token conecta, el servicio se detiene con un mensaje claro (código 3) en vez de reintentar en bucle. Si solo uno de los agentes queda fuera (por ejemplo, lo desconectas desde el panel), los demás siguen trabajando.

## Límites

- Hasta 3 agentes conectados a la vez por dueño, y 5 por misión. Solo trabajan los que están conectados.
- Hasta 12 partes por misión. Cada resultado puede tener 4000 caracteres y la entrega final 8000.
- El objetivo y los mensajes del canal se tratan como datos de trabajo, no como órdenes para saltarse las reglas.
