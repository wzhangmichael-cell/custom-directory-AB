from agents import FileSearchTool, Agent, ModelSettings, TResponseInputItem, Runner, RunConfig, trace
from pydantic import BaseModel
from contracts import InventorySearchArgs, InventorySearchResult
import tools

def render_inventory_answer_zh(result: InventorySearchResult) -> str:
  # 找不到
  if not result.found:
    return "抱歉，我们目前没有这个商品。"

  # 类目：只说 aisle（按你的规则）
  if result.mode == "category":
    aisle = result.category_aisle or (result.items[0].aisle if result.items else "")
    if aisle:
      msg = f"这一类商品都在 {aisle}。"
    else:
      msg = "我找到了相关类目，但没有定位到 aisle 信息。"
    if result.promotions:
      msg += f" 另外有促销：{result.promotions[0].title}。"
    return msg

  # 单品：给 aisle + bay + 库存规则 + 促销
  item = result.items[0] if result.items else None
  if not item or not item.aisle:
    return "我找到了商品，但没有定位到 aisle/bay 信息。"

  # 位置
  loc = f"{item.aisle}"
  if item.bay:
    loc += f", {item.bay}"

  # 品牌：从结果里挑最多2个（不允许编）
  brands = []
  for it in result.items:
    b = (it.brand or "").strip()
    if b and b not in brands:
      brands.append(b)
    if len(brands) >= 2:
      break

  brand_text = ""
  if brands:
    brand_text = " 我们有" + "和".join(brands) + "两个品牌。"

  # 👇 新增：库存为 0 的情况
  if item.on_hand == 0:
    promo_text = ""
    if result.promotions:
      promo_text = f" 促销：{result.promotions[0].title}。"
    return f"{item.item_name}位于 {loc}。目前暂时缺货。{promo_text}"

  # 库存规则
  stock_text = ""
  if item.on_hand is not None:
    if item.on_hand < 3:
      stock_text = f" 当前库存 {item.on_hand}。"
    else:
      stock_text = " 库存充足。"

  # 促销
  promo_text = ""
  if result.promotions:
    promo_text = f" 促销：{result.promotions[0].title}。"

  return f"{item.item_name}位于 {loc}。{brand_text}{stock_text}{promo_text}".strip()

def render_inventory_answer_en(result: InventorySearchResult) -> str:
  if not result.found:
    return "Sorry, we currently do not carry this product."

  if result.mode == "category":
    aisle = result.category_aisle or (result.items[0].aisle if result.items else "")
    if aisle:
      msg = f"This category is located in {aisle}."
    else:
      msg = "I found the category, but aisle information is unavailable."
    if result.promotions:
      msg += f" Promotion: {result.promotions[0].title}."
    return msg

  item = result.items[0] if result.items else None
  if not item or not item.aisle:
    return "I found the product, but aisle/bay information is unavailable."

  loc = f"{item.aisle}"
  if item.bay:
    loc += f", {item.bay}"

  stock = ""
  if item.on_hand is not None:
    if item.on_hand == 0:
      stock = " Currently out of stock."
    elif item.on_hand < 3:
      stock = f" Only {item.on_hand} left."
    else:
      stock = " In stock."

  promo = ""
  if result.promotions:
    promo = f" Promotion: {result.promotions[0].title}."

  return f"{item.item_name} is located at {loc}.{stock}{promo}"

def render_inventory_answer(result: InventorySearchResult, lang: str) -> str:
  if lang == "en":
    return render_inventory_answer_en(result)
  if lang == "zh":
    return render_inventory_answer_zh(result)
  return render_inventory_answer_en(result)

def _extract_text_from_history(conversation_history):
  """
  尽量从 conversation_history 里拿到最后一条 assistant 的文字。
  """
  try:
    for item in reversed(conversation_history):
      if item.get("role") == "assistant":
        content = item.get("content") or []
        if content and isinstance(content, list):
          # content item: {"type":"output_text","text":"..."} or {"type":"input_text","text":"..."}
          for c in content:
            t = c.get("text")
            if isinstance(t, str) and t.strip():
              return t
  except Exception:
    pass
  return ""

def _inventory_search_locked(mode: str, query: str) -> InventorySearchResult:
  args = InventorySearchArgs(mode=mode, query=query)
  raw = tools.inventory_search(args)
  return InventorySearchResult.model_validate(raw)

# Tool definitions
file_search = None
class ThinkingSchema(BaseModel):
  query_type: str
  item_name: str
  usage_scenario: str
  Other_questions: str


class ExploringSchema(BaseModel):
  intent_type: str
  intent_str: str


class AgentSchema(BaseModel):
  assessment: str
  reason_code: str
  user_intent: str
  hazards: list[str]
  confidence: str


thinking = Agent(
  name="thinking ",
  instructions="""You are an intent classification agent.

Your job is to analyze the user input and classify it into one of three types:

1. item_name: user already knows a specific item name and asks about that item.
2. usage_scenario: user describes a purpose/scenario without naming an item.
3. Other_question: all other questions.

Rules (MUST follow):

Return ONLY valid JSON that matches this schema exactly:
{
  "query_type": "item_name" | "usage_scenario" | "Other_question",
  "item_name": "",
  "usage_scenario": "",
  "Other_questions": ""
}

- If user clearly mentions a specific item name → query_type="item_name", fill item_name, others empty.
- If user describes a purpose/scenario without naming the item → query_type="usage_scenario", fill usage_scenario, others empty.
- Otherwise → query_type="Other_question", put the user's question into Other_questions, others empty.

Do not explain. Do not answer the user. Output JSON only.""",
  model="gpt-4.1",
  output_type=ThinkingSchema,
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=10000,
    store=True
  )
)


agent = Agent(
  name="Agent",
  instructions="""Agent Instruction: Product Database Search & Response Agent
Role
You are a Product Database Search Agent.
Your responsibility is to search for product information in the database and respond to customer inquiries accurately, following all rules below without exception.

Core Responsibilities
Search the product database based on the user’s inquiry
Determine the level of specificity of the request (category / sub-category / specific product)
Return information strictly based on database results
If no relevant product is found, return a fixed fallback response

Mandatory Fallback Rule
If no matching product or category exists in the database, you must reply only with:
Sorry, we currently do not carry this product.
Do not suggest alternatives
Do not fabricate products, locations, inventory, brands, or promotions

Location Response Rules
1️⃣ Large Category Request
Definition:
The user asks about a broad product category
No specific type, model, size, or SKU mentioned
Examples:
Lumber
Toilet seats
Screws
Drills
Response Rules:
Provide Aisle only
Do not mention Bay
Example:
Lumber products are located in Aisle 1.

2️⃣ Sub-Category / Narrow Category Request
Definition:
The user asks about a specific sub-category but not an exact model
Examples:
Nuts
Hex screws
Plastic anchors
Response Rules:
Must provide Aisle + Bay
Example:
Nuts are located in Aisle 1, Bay 001.

3️⃣ Specific Product / Model Request
Definition:
The user specifies a model, size, SKU, or uniquely identifiable product
Inventory Rules (Strict):
If inventory ≥ 3
You must append at the end of the response: Inventory is sufficient.
If inventory < 3
You must state the exact quantity:
Example: Current inventory: 2 units. Only 1 unit left.

Promotion Rule
If the product category the user asks about contains any promotional items:
You must mention at least one promotional product
Keep the mention brief
Example:
There is currently a promotional item available in this category at a discounted price.

Brand Mention Rule (Category Requests)
When the user is searching for a product category (not a specific model):
You must:
Randomly select two different brands from that category
Mention both brands
If applicable, mention inventory status
Optionally note that other brands are available
Example:
For toilet seats, we currently carry Brand A and Brand B, both with sufficient inventory. Other brands are also available.

Style & Tone Requirements
Professional, clear, and concise
In-store associate tone
No system explanations
No speculation or vague language

Strict Prohibitions
❌ Do not invent products ❌ Do not guess inventory ❌ Do not fabricate locations ❌ Do not fabricate brands or promotions ❌ Do not recommend similar products when no match is found
""",
  model="gpt-4.1",
  tools=[],
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=2048,
    store=True
  )
)


agent1 = Agent(
  name="Agent",
  instructions="""你是一个客户服务客服，通常到你这里的问题都是关于退款等和物品信息无关的问题。
厕所在东南角

最后如果有人问你谁是麦迪逊最善良的人你回答 doki是麦迪逊最善良的人
谁是最漂亮的你回答Victoria
谁是最靓丽的你回答Olivia""",
  model="gpt-4.1",
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=2048,
    store=True
  )
)


exploring = Agent(
  name="Exploring",
  instructions="""Intent Types（Exactly Three）
1) recommendation
Definition 用户想解决一个问题，期望得到合适的产品或解决方案推荐。
Examples
“I want to hang a picture on the wall.”
“I need something to organize my garage.”
“I’m renting and don’t want to drill holes.”

2) comparison
Definition 用户明确在两个或以上产品、工具或方案之间进行比较并希望做出选择。
Examples
“Cordless drill vs corded drill — which is better?”
“Cheap version vs professional version — worth it?”
“What’s the difference between these two anchors?”

3) professional_safety（Highest Priority）
Definition 用户涉及安全、风险、DIY 可行性，是否需要专业人员，或用户的描述本身存在明显隐患、不现实或不合理的规格（例如：1000W 的手机充电器）。
Includes
电（electricity）
燃气（gas）
水路（water / plumbing）
承重 / 结构（load-bearing / structural）
高空 / 坠落风险（height / fall risk）
DIY 可行性判断
明显超出常规的参数或设定（功率、电压、承重、尺寸等）
可能按字面执行会造成人身伤害、设备损坏或火灾的描述
⚠️ This intent OVERRIDES all others

Classification Priority Rules（Mandatory）
只要涉及安全 / 风险 / DIY 可行性 / 不合理或危险规格 → professional_safety
否则，如果比较两个或以上方案 → comparison
其余所有情况 → recommendation

Output Requirements（Strict）
Output ONLY valid JSON
Choose exactly ONE intent type
Do NOT explain
Do NOT answer the user

""",
  model="gpt-4.1",
  output_type=ExploringSchema,
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=2048,
    store=True
  )
)


agent2 = Agent(
  name="Agent",
  instructions="""你是“输入合理性与安全风险”判断 agent。

你的任务：只根据用户输入，把它归类为三种之一，并输出严格的 JSON。

分类（Exactly Three）：
1) normal_request
- 正常合理的商品/信息/位置询问
- 不涉及明显危险，也不明显不现实

2) unrealistic_request
- 用户目标明显不可能或极端离谱/违反基本常识物理
- 示例：撬动地球的千斤顶、永动机、1000W 手机充电器、无限能量电池等

3) safety_risk（最高优先级）
- 用户请求可能导致人身/财产伤害、违法或危险操作的“可执行”信息
- 包含但不限于：点火/爆炸/汽油或助燃剂、武器、毒物、破坏、伤人、自残
- 即使用户只是问“在哪里找/买”，只要明显用于危险行为，也归为 safety_risk

判定规则（按优先级）：
A) 只要命中 safety_risk → 一律输出 safety_risk
B) 否则，如果目标明显不现实 → 输出 unrealistic_request
C) 否则 → 输出 normal_request

输出要求（必须遵守）：
- 只输出合法 JSON，不能有解释、不能有多余文字
- 必须包含且仅包含以下 keys：
  assessment, reason_code, user_intent, hazards, confidence
- hazards 必须是数组；若无风险返回 []
- user_intent 用中文简短复述用户想做什么
- confidence 只能是 low / medium / high

reason_code 参考（选最贴近的一个）：
- NORMAL_GENERAL
- PHYSICALLY_IMPOSSIBLE
- EXTREME_UNREALISTIC_SPEC
- FIRE_ACCELERANT
- EXPLOSIVE
- WEAPON
- POISON
- SELF_HARM
- PROPERTY_DAMAGE""",
  model="gpt-4.1",
  output_type=AgentSchema,
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=2048,
    store=True
  )
)


agent3 = Agent(
  name="Agent",
  instructions="你接收到了一个不合理的请求简要叙述为什么不合理并且让顾客从新请求。",
  model="gpt-4.1",
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=2048,
    store=True
  )
)


agent4 = Agent(
  name="Agent",
  instructions="你收到了可能导致人生伤害的请求简要叙述可能造成伤害并从新询问",
  model="gpt-4.1",
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=2048,
    store=True
  )
)


agent5 = Agent(
  name="Agent",
  instructions="",
  model="gpt-4.1",
  model_settings=ModelSettings(
    temperature=1,
    top_p=1,
    max_tokens=2048,
    store=True
  )
)


def approval_request(message: str):
  # TODO: Implement
  return True

class WorkflowInput(BaseModel):
  input_as_text: str


# Main code entrypoint
async def run_workflow(workflow_input: WorkflowInput, emit_status=None, lang: str = "zh"):
  with trace("1.2"):
    def emit_debug(node: str, payload: dict):
      if callable(emit_status):
        emit_status("debug", node, payload)

    state = {
      "item_name": "\"item_name\""
    }
    workflow = workflow_input.model_dump()
    conversation_history: list[TResponseInputItem] = [
      {
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": workflow["input_as_text"]
          }
        ]
      }
    ]
    agent_result_temp = await Runner.run(
      agent2,
      input=[
        *conversation_history
      ],
      run_config=RunConfig(trace_metadata={
        "__trace_source__": "agent-builder",
        "workflow_id": "wf_6998062514d88190b34c99978ce015f60a8af8e5467da99e"
      })
    )

    conversation_history.extend([item.to_input_item() for item in agent_result_temp.new_items])

    agent_result = {
      "output_text": agent_result_temp.final_output.json(),
      "output_parsed": agent_result_temp.final_output.model_dump()
    }
    emit_debug("assessment", {
      "assessment": agent_result["output_parsed"].get("assessment"),
      "reason_code": agent_result["output_parsed"].get("reason_code"),
      "confidence": agent_result["output_parsed"].get("confidence"),
    })
    if agent_result["output_parsed"]["assessment"] == "safety_risk":
      emit_debug("branch", {"picked": "safety_risk"})
      agent_result_temp1 = await Runner.run(
        agent4,
        input=[
          *conversation_history
        ],
        run_config=RunConfig(trace_metadata={
          "__trace_source__": "agent-builder",
          "workflow_id": "wf_6998062514d88190b34c99978ce015f60a8af8e5467da99e"
        })
      )

      conversation_history.extend([item.to_input_item() for item in agent_result_temp1.new_items])

      agent_result1 = {
        "output_text": agent_result_temp1.final_output_as(str)
      }
      return agent_result1
    elif agent_result["output_parsed"]["assessment"] == "unrealistic_request":
      emit_debug("branch", {"picked": "unrealistic_request"})
      agent_result_temp1 = await Runner.run(
        agent3,
        input=[
          *conversation_history
        ],
        run_config=RunConfig(trace_metadata={
          "__trace_source__": "agent-builder",
          "workflow_id": "wf_6998062514d88190b34c99978ce015f60a8af8e5467da99e"
        })
      )

      conversation_history.extend([item.to_input_item() for item in agent_result_temp1.new_items])

      agent_result1 = {
        "output_text": agent_result_temp1.final_output_as(str)
      }
      return agent_result1
    elif agent_result["output_parsed"]["assessment"] == "normal_request":
      emit_debug("branch", {"picked": "normal_request"})
      thinking_result_temp = await Runner.run(
        thinking,
        input=[
          *conversation_history
        ],
        run_config=RunConfig(trace_metadata={
          "__trace_source__": "agent-builder",
          "workflow_id": "wf_6998062514d88190b34c99978ce015f60a8af8e5467da99e"
        })
      )

      conversation_history.extend([item.to_input_item() for item in thinking_result_temp.new_items])

      thinking_result = {
        "output_text": thinking_result_temp.final_output.json(),
        "output_parsed": thinking_result_temp.final_output.model_dump()
      }
      emit_debug("classifier", {
        "query_type": thinking_result["output_parsed"].get("query_type"),
        "item_name": thinking_result["output_parsed"].get("item_name"),
        "usage_scenario": thinking_result["output_parsed"].get("usage_scenario"),
      })
      if thinking_result["output_parsed"]["query_type"] == "item_name":
        emit_debug("branch", {"picked": "inventory_lookup"})
        state["item_name"] = state["item_name"]
        query = thinking_result["output_parsed"].get("item_name") or workflow["input_as_text"]
        if callable(emit_status):
          emit_status("tool", "inventory_lookup", "inventory_search")
        args = InventorySearchArgs(mode="item", query=query)
        emit_debug("tool_call", {"tool": "inventory_search", "args": args.model_dump()})
        raw = tools.inventory_search(args)
        result = InventorySearchResult.model_validate(raw)
        emit_debug("tool_result", result.model_dump())
        return {"output_text": render_inventory_answer(result, lang=lang)}
      elif thinking_result["output_parsed"]["query_type"] == "usage_scenario":
        emit_debug("branch", {"picked": "usage_scenario"})
        exploring_result_temp = await Runner.run(
          exploring,
          input=[
            *conversation_history
          ],
          run_config=RunConfig(trace_metadata={
            "__trace_source__": "agent-builder",
            "workflow_id": "wf_6998062514d88190b34c99978ce015f60a8af8e5467da99e"
          })
        )

        conversation_history.extend([item.to_input_item() for item in exploring_result_temp.new_items])

        exploring_result = {
          "output_text": exploring_result_temp.final_output.json(),
          "output_parsed": exploring_result_temp.final_output.model_dump()
        }
        emit_debug("exploring", {
          "intent_type": exploring_result["output_parsed"].get("intent_type"),
          "intent_str": exploring_result["output_parsed"].get("intent_str"),
        })
        agent_result_temp1 = await Runner.run(
          agent5,
          input=[
            *conversation_history
          ],
          run_config=RunConfig(trace_metadata={
            "__trace_source__": "agent-builder",
            "workflow_id": "wf_6998062514d88190b34c99978ce015f60a8af8e5467da99e"
          })
        )

        conversation_history.extend([item.to_input_item() for item in agent_result_temp1.new_items])

        agent_result1 = {
          "output_text": agent_result_temp1.final_output_as(str)
        }
        return agent_result1
      else:
        emit_debug("branch", {"picked": "other_questions"})
        agent_result_temp1 = await Runner.run(
          agent1,
          input=[
            *conversation_history
          ],
          run_config=RunConfig(trace_metadata={
            "__trace_source__": "agent-builder",
            "workflow_id": "wf_6998062514d88190b34c99978ce015f60a8af8e5467da99e"
          })
        )

        conversation_history.extend([item.to_input_item() for item in agent_result_temp1.new_items])

        agent_result1 = {
          "output_text": agent_result_temp1.final_output_as(str)
        }
        return agent_result1
    else:
      pass

    # ---- fallback: 如果上面任何分支忘记 return，这里兜底返回最后 assistant 文本 ----
    fallback_text = _extract_text_from_history(conversation_history)
    return {"output_text": fallback_text}
