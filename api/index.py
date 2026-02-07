import os
import json
import base64
import io
import re
import logging
from datetime import datetime, timezone

from flask import Flask, request, jsonify, render_template, send_from_directory
from dotenv import load_dotenv

# Suppress file_cache warning from google-api-python-client
logging.getLogger('googleapiclient.discovery_cache').setLevel(logging.ERROR)

load_dotenv()

app = Flask(
    __name__,
    template_folder=os.path.join(os.path.dirname(__file__), '..', 'templates'),
    static_folder=os.path.join(os.path.dirname(__file__), '..', 'static'),
)

# ===== Config Loading =====
CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'questions.json')


def load_config():
    with open(CONFIG_PATH, 'r') as f:
        return json.load(f)


# ===== Google Auth Helper =====
def get_google_credentials():
    """Decode base64-encoded service account JSON from env var."""
    creds_b64 = os.environ.get('GOOGLE_SHEETS_CREDS', '')
    if not creds_b64:
        raise ValueError('GOOGLE_SHEETS_CREDS environment variable is not set')

    creds_json = base64.b64decode(creds_b64).decode('utf-8')
    creds_info = json.loads(creds_json)

    from google.oauth2.service_account import Credentials
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
    ]
    return Credentials.from_service_account_info(creds_info, scopes=scopes)


# ===== Routes =====

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory(app.static_folder, filename)


@app.route('/api/config', methods=['GET'])
def get_config():
    """Return the questions config to the frontend."""
    config = load_config()
    return jsonify(config)


@app.route('/api/assess', methods=['POST'])
def assess():
    """Receive an image and metadata, analyze with Claude, return structured JSON."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    image_b64 = data.get('image')
    media_type = data.get('media_type', 'image/jpeg')
    metadata = data.get('metadata', {})

    if not image_b64:
        return jsonify({'error': 'No image provided'}), 400

    api_key = os.environ.get('ANTHROPIC_API_KEY', '')
    if not api_key:
        return jsonify({'error': 'ANTHROPIC_API_KEY is not configured'}), 500

    # Load config and build prompt
    config = load_config()
    prompt = build_assessment_prompt(config, metadata)

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)

        message = client.messages.create(
            model='claude-sonnet-4-5-20250929',
            max_tokens=4096,
            messages=[
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'image',
                            'source': {
                                'type': 'base64',
                                'media_type': media_type,
                                'data': image_b64,
                            },
                        },
                        {
                            'type': 'text',
                            'text': prompt,
                        },
                    ],
                }
            ],
        )

        # Extract text response
        response_text = message.content[0].text

        # Parse JSON from the response (handle markdown code fences)
        result = parse_json_response(response_text)
        return jsonify(result)

    except Exception as e:
        return jsonify({'error': f'AI analysis failed: {str(e)}'}), 500


@app.route('/api/submit', methods=['POST'])
def submit():
    """Submit assessment results to Google Sheet and upload image to Google Drive."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    metadata = data.get('metadata', {})
    assessments = data.get('assessments', {})
    inferred_metadata = data.get('inferred_metadata', {})
    accessibility_rating = data.get('accessibility_rating', '')
    final_comments = data.get('final_comments', '')
    overall_notes = data.get('overall_notes', '')
    image_b64 = data.get('image', '')
    media_type = data.get('media_type', 'image/jpeg')

    sheet_id = os.environ.get('GOOGLE_SHEET_ID', '')
    drive_folder_id = os.environ.get('GOOGLE_DRIVE_FOLDER_ID', '')

    if not sheet_id:
        return jsonify({'error': 'GOOGLE_SHEET_ID is not configured'}), 500

    try:
        creds = get_google_credentials()

        # Upload image to Google Drive
        image_link = ''
        if image_b64 and drive_folder_id:
            image_link = upload_to_drive(creds, image_b64, media_type, metadata, drive_folder_id)

        # Append to Google Sheet
        append_to_sheet(creds, sheet_id, metadata, assessments, inferred_metadata,
                        accessibility_rating, final_comments, overall_notes, image_link)

        return jsonify({'success': True})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ===== Helpers =====

def build_assessment_prompt(config, metadata):
    """Build the Claude prompt from the questions config."""
    metadata_context = ''
    if metadata:
        metadata_context = '\nUser-provided context about this sign:\n'
        for key, value in metadata.items():
            if value:
                metadata_context += f'- {key}: {value}\n'

    # Build AI-inferred fields instructions
    ai_fields = config.get('ai_inferred_fields', [])
    ai_fields_instructions = ''
    ai_fields_schema = ''
    for field in ai_fields:
        options = field.get('options', [])
        options_str = ', '.join(f'"{o}"' for o in options)
        ai_fields_instructions += f'- **{field["id"]}**: {field["label"]}. Must be one of: {options_str}\n'
        ai_fields_schema += f'    "{field["id"]}": "one of: {", ".join(options)}",\n'

    # Build category assessment instructions
    categories_text = ''
    category_ids = []
    for category in config.get('categories', []):
        categories_text += f'\n### {category["name"]} (id: "{category["id"]}")\n'
        if category.get('guidance'):
            categories_text += f'Evaluation criteria:\n{category["guidance"]}\n'
        category_ids.append(category['id'])

    # Build overall rating options
    rating_config = config.get('overall_rating', {})
    rating_options = rating_config.get('options', [])
    rating_options_str = ', '.join(f'"{o}"' for o in rating_options)

    prompt = f"""You are a strict, detail-oriented accessibility auditor evaluating a digital sign on a university campus for compliance with Section 504 accessibility standards. You have high standards and err on the side of flagging issues rather than giving the benefit of the doubt.

IMPORTANT RATING PHILOSOPHY:
- Be critical and thorough. Most signs have accessibility issues — a "Fully Accessible" rating should be rare.
- Do NOT default to positive assessments. If something is borderline, flag it as a concern.
- Even signs that look "good enough" often fail specific WCAG criteria on closer inspection.
- A sign must excel in ALL categories to receive a top rating. A single significant issue should pull the overall rating down.
- "Mostly Accessible" should be the ceiling for signs with any notable concern. "Partially Accessible" or lower is appropriate when multiple issues exist.
- Small text, low contrast, cluttered layouts, missing QR codes for URLs, and poor color choices are all common issues that should be called out specifically.
{metadata_context}
Analyze the attached photo of a digital sign and provide a detailed, critical assessment for each category below.

For each category, write a 2-4 sentence assessment paragraph that:
- Describes what you observe on the sign relevant to that category
- Explicitly identifies any accessibility concerns, even minor ones
- References specific elements visible in the image
- Does NOT gloss over issues or use overly positive language

Important assessment guidelines:
- For **Contrast and Color Blindness**: Strictly evaluate contrast ratios. WCAG 2.1 requires 4.5:1 for normal text and 3:1 for large text — if contrast looks questionable, say so. Flag any red/green or blue/yellow color combinations used without alternative indicators. Note if italics are used for large blocks of text. Be skeptical — most signs do NOT meet WCAG contrast standards.
- For **Text Readability**: Critically assess font size, simplicity, whitespace, and whether ALL content can be read within ~15 seconds from a reasonable distance. Flag long URLs without QR codes. Flag decorative/hard-to-read fonts. Flag text that is too small for the viewing distance. Flag overcrowded layouts.
- For **Image Clarity**: Check if images are clear, appropriately sized, and not cluttered. Flag stock photos, low resolution, and excessive visual clutter. Be strict about brand guideline compliance and visual hierarchy.
- For **Interactive Display**: If the sign is NOT interactive, simply write "N/A - This is not an interactive display." If it IS interactive, strictly assess button height (36-42 inches ADA standard), touch element reach (10-inch range), and wayfinding accessibility.
- If the sign appears to be **off, blank, or not displaying content**, note this clearly and rate it as "Not Accessible."

Also determine the following from the image:
{ai_fields_instructions}- Any visible building or location identifiers
- Any other relevant contextual details

Based on your assessment, suggest an overall accessibility rating. Be strict — most signs should NOT receive "Fully Accessible" or even "Mostly Accessible" unless they truly excel in every category. If any category has a notable issue, the overall rating should reflect that. Must be one of: {rating_options_str}

Return your response as valid JSON matching this exact schema. Do NOT wrap it in markdown code fences.

{{
  "inferred_metadata": {{
{ai_fields_schema}    "building": "building name if visible, or null",
    "additional_context": "any other observations"
  }},
  "assessments": {{
{chr(10).join(f'    "{cid}": "Your 2-4 sentence assessment paragraph...",' for cid in category_ids)}
  }},
  "accessibility_rating": "one of: {', '.join(rating_options)}",
  "final_comments": "Any additional accessibility observations not covered by the categories above",
  "overall_notes": "Extra context about the sign environment, placement, or other relevant details"
}}

Categories to evaluate:
{categories_text}"""

    return prompt


def parse_json_response(text):
    """Parse JSON from Claude's response, handling markdown code fences."""
    # Try to extract JSON from code fences
    fence_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1)

    # Try to find JSON object
    brace_start = text.find('{')
    if brace_start != -1:
        # Find the matching closing brace
        depth = 0
        for i in range(brace_start, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    text = text[brace_start:i + 1]
                    break

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Return a fallback structure
        return {
            'inferred_metadata': {},
            'assessments': {},
            'overall_notes': f'Failed to parse AI response. Raw response: {text[:500]}',
        }


def upload_to_drive(creds, image_b64, media_type, metadata, folder_id):
    """Upload image to Google Drive and return a shareable link."""
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseUpload

    service = build('drive', 'v3', credentials=creds, cache_discovery=False)

    # Build filename
    building = metadata.get('building', 'unknown').replace(' ', '_')
    location = metadata.get('screen_location', '').replace(' ', '_')
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    filename = f'{building}_{location}_{timestamp}.jpg'

    # Decode image
    image_bytes = base64.b64decode(image_b64)
    media = MediaIoBaseUpload(io.BytesIO(image_bytes), mimetype=media_type)

    file_metadata = {
        'name': filename,
        'parents': [folder_id],
    }

    file = service.files().create(
        body=file_metadata,
        media_body=media,
        fields='id, webViewLink',
        supportsAllDrives=True,
    ).execute()

    # Make viewable by anyone with link
    service.permissions().create(
        fileId=file['id'],
        body={'type': 'anyone', 'role': 'reader'},
        supportsAllDrives=True,
    ).execute()

    return file.get('webViewLink', '')


def append_to_sheet(creds, sheet_id, metadata, assessments, inferred_metadata,
                    accessibility_rating, final_comments, overall_notes, image_link):
    """Append one row of assessment results to the Google Sheet."""
    import gspread

    # Decode service account JSON for gspread's native auth (avoids file_cache issues)
    creds_b64 = os.environ.get('GOOGLE_SHEETS_CREDS', '')
    creds_json = json.loads(base64.b64decode(creds_b64).decode('utf-8'))
    gc = gspread.service_account_from_dict(creds_json)
    sheet = gc.open_by_key(sheet_id).sheet1

    config = load_config()

    # Ensure header row exists — write it directly to row 1 if missing
    headers = build_header_row(config)
    try:
        first_cell = sheet.cell(1, 1).value
    except Exception:
        first_cell = None

    if first_cell != 'Timestamp':
        # Write header into row 1 (overwrites whatever is there)
        sheet.update(range_name='A1', values=[headers], value_input_option='USER_ENTERED')

    # Build data row
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    row = [timestamp]

    # Metadata columns (user-entered + auto-populated like floor_owner)
    for field in config.get('metadata_fields', []):
        row.append(metadata.get(field['id'], ''))

    # AI-inferred fields (sign_type, orientation, etc.)
    for field in config.get('ai_inferred_fields', []):
        row.append(inferred_metadata.get(field['id'], ''))

    # Image link
    row.append(image_link)

    # Assessment columns (one text column per category)
    for category in config.get('categories', []):
        row.append(assessments.get(category['id'], ''))

    # Accessibility rating
    row.append(accessibility_rating)

    # Final comments
    row.append(final_comments)

    # Overall notes
    row.append(overall_notes)

    # Extra inferred context (building, additional_context — anything not in ai_inferred_fields)
    ai_field_ids = {f['id'] for f in config.get('ai_inferred_fields', [])}
    extra_inferred = ', '.join(
        f'{k}: {v}' for k, v in inferred_metadata.items() if v and k not in ai_field_ids
    )
    row.append(extra_inferred)

    sheet.append_row(row, value_input_option='USER_ENTERED')


def build_header_row(config):
    """Build the header row for the Google Sheet based on the config."""
    # Use cleaner column names for readability
    LABEL_OVERRIDES = {
        'assessor_name': 'Assessor Name',
        'evaluation_team': 'Evaluation Team',
        'assessor_email': 'Email',
        'building': 'Building',
        'screen_location': 'Screen Location',
        'reviewed_on': 'Date Reviewed',
        'floor_owner': 'Floor Owner',
    }

    headers = ['Timestamp']

    for field in config.get('metadata_fields', []):
        headers.append(LABEL_OVERRIDES.get(field['id'], field['label']))

    for field in config.get('ai_inferred_fields', []):
        headers.append(field['label'])

    headers.append('Image Link')

    for category in config.get('categories', []):
        headers.append(category['name'])

    headers.append('Accessibility Rating')
    headers.append('Final Comments')
    headers.append('Overall Notes')
    headers.append('AI Additional Context')

    return headers


# ===== Local Dev =====
if __name__ == '__main__':
    app.run(debug=True, port=5000)
