import json
import re

with open('test-data/SBC_Accounting_Data_Creation_postman_collection.json', 'r') as f:
    col = json.load(f)

targets = [
    'business_data',
    'ledger_data',
    'bank_data',
    'contact_data',
    'pm_product_sales_price_types_data'
]

def adapt_script(lines):
    new_lines = []
    skip_send_request = False
    brace_depth = 0

    for line in lines:
        # If in pm.sendRequest block for token refresh, comment it out so Newman doesn't burn single-use refresh tokens
        if 'pm.sendRequest({' in line or 'if (pm.environment.get("accessTokenExpires")' in line:
            skip_send_request = True
            brace_depth += line.count('{') - line.count('}')
            new_lines.append('// [ADAPTED] Token refresh managed externally by runner')
            continue

        if skip_send_request:
            brace_depth += line.count('{') - line.count('}')
            if brace_depth <= 0:
                skip_send_request = False
            continue

        # Check SET
        matched_set = False
        for t in targets:
            pattern = rf'pm\.environment\.set\("{t}",\s*bodyData\);?'
            if re.search(pattern, line):
                new_lines.append(f'pm.environment.set("{t}", typeof bodyData === "string" ? bodyData : JSON.stringify(bodyData));')
                matched_set = True
                break
        if matched_set:
            continue

        # Check GET
        matched_get = False
        for t in targets:
            pattern = rf'([a-zA-Z0-9_]+)\s*=\s*pm\.environment\.get\("{t}"\);?'
            m = re.search(pattern, line)
            if m:
                var_name = m.group(1)
                replacement = f'{var_name} = (function(k) {{ var v = pm.environment.get(k); if (typeof v === "string") {{ try {{ return JSON.parse(v); }} catch (e) {{ return v; }} }} return v; }})("{t}");'
                new_lines.append(replacement)
                matched_get = True
                break
        if matched_get:
            continue

        new_lines.append(line)
    return new_lines

def process_item(item):
    for ev in item.get('event', []):
        script = ev.get('script', {})
        if 'exec' in script:
            script['exec'] = adapt_script(script['exec'])
    for ch in item.get('item', []):
        process_item(ch)

for it in col.get('item', []):
    process_item(it)

with open('test-data/SBC_Accounting_Data_Creation_adapted.json', 'w') as f:
    json.dump(col, f, indent=2)

print("Regenerated adapted collection without internal token burner: test-data/SBC_Accounting_Data_Creation_adapted.json")
