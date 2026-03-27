from flask import Flask, render_template, request, jsonify
from app_logger import get_logger
import json
import jsonschema
import os
import shutil
from datetime import datetime, timezone


# init logging
logger = get_logger(__name__)

# init app
app = Flask(__name__)

MODELS_DIR = os.path.join('data', 'models')
LAYOUTS_DIR = os.path.join(MODELS_DIR, 'layouts')


def list_model_stems():
    """Canonical model stems only (excludes working copies temp_<stem>)."""
    stems = []
    for name in os.listdir(MODELS_DIR):
        path = os.path.join(MODELS_DIR, name)
        if os.path.isfile(path) and name.lower().endswith('.json'):
            stem = os.path.splitext(name)[0]
            if not stem.startswith('temp_'):
                stems.append(stem)
    return sorted(stems)


def working_stem(canonical_stem):
    return f'temp_{canonical_stem}'


def is_working_stem(stem):
    return isinstance(stem, str) and stem.startswith('temp_')


def parse_model_stem(raw):
    """Return (stem, None) on success, or (None, reason) with reason 'empty' or 'unsafe'."""
    if not isinstance(raw, str) or not raw.strip():
        return None, 'empty'
    stem = raw.strip()
    if '/' in stem or '\\' in stem or stem in ('.', '..') or os.path.basename(stem) != stem:
        return None, 'unsafe'
    return stem, None


def model_json_path(stem):
    return os.path.join(MODELS_DIR, f'{stem}.json')


def layout_json_path(stem):
    return os.path.join(LAYOUTS_DIR, f'{stem}.json')


def stem_from_post_json():
    """For load_model / load_layout: canonical stem must exist in list; working temp_* must exist on disk."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify({'error': 'expected JSON object'}), 400)
    stem, why = parse_model_stem(data.get('model'))
    if stem is None:
        msg = 'invalid model' if why == 'unsafe' else 'missing or invalid model'
        return None, (jsonify({'error': msg}), 400)
    if is_working_stem(stem):
        if not os.path.isfile(model_json_path(stem)):
            return None, (jsonify({'error': 'unknown model'}), 404)
        return stem, None
    if stem not in list_model_stems():
        return None, (jsonify({'error': 'unknown model'}), 404)
    return stem, None


def stem_from_post_create():
    """Stem from POST JSON for create_model: accepts 'stem' or 'model'; must not already exist."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify({'success': False, 'error': 'expected JSON object'}), 400)
    stem_key = data.get('stem')
    if stem_key is None:
        stem_key = data.get('model')
    stem, why = parse_model_stem(stem_key)
    if stem is None:
        msg = 'invalid model' if why == 'unsafe' else 'missing or invalid model'
        return None, (jsonify({'success': False, 'error': msg}), 400)
    if stem.startswith('temp_'):
        return None, (jsonify({'success': False, 'error': 'model name cannot start with temp_'}), 400)
    if stem in list_model_stems():
        return None, (jsonify({'success': False, 'error': 'a model with this name already exists'}), 409)
    return stem, None


def stem_from_save_layout_query():
    raw = request.args.get('model', type=str)
    if raw is None:
        return None, (jsonify({'success': False, 'error': 'missing model query parameter'}), 400)
    stem, why = parse_model_stem(raw)
    if stem is None:
        if why == 'empty':
            return None, (jsonify({'success': False, 'error': 'missing model query parameter'}), 400)
        return None, (jsonify({'success': False, 'error': 'invalid model'}), 400)
    if is_working_stem(stem):
        return stem, None
    if stem not in list_model_stems():
        return None, (jsonify({'success': False, 'error': 'unknown model'}), 400)
    return stem, None


def utc_iso_timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


@app.route('/api/create_model', methods=['POST'])
def api_create_model():
    stem, err = stem_from_post_create()
    if err:
        return err
    data = request.get_json(silent=True)
    name = data.get('name')
    if name is None or (isinstance(name, str) and not name.strip()):
        name = stem
    elif not isinstance(name, str):
        return jsonify({'success': False, 'error': 'invalid name'}), 400
    else:
        name = name.strip()
    description = data.get('description', '')
    if not isinstance(description, str):
        return jsonify({'success': False, 'error': 'invalid description'}), 400
    now = utc_iso_timestamp()
    model_doc = {
        'meta': {
            'name': name,
            'description': description,
            'created': now,
            'modified': now,
        },
        'entities': [],
        'relationships': [],
    }
    layout_doc = {'layout': []}
    with open('schemas/model.json') as f:
        model_schema = json.load(f)
    with open('schemas/layout.json') as f:
        layout_schema = json.load(f)
    try:
        jsonschema.validate(instance=model_doc, schema=model_schema)
        jsonschema.validate(instance=layout_doc, schema=layout_schema)
    except jsonschema.ValidationError as e:
        logger.error('create_model validation failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 400
    try:
        wstem = working_stem(stem)
        model_path = model_json_path(wstem)
        layout_path = layout_json_path(wstem)
        os.makedirs(LAYOUTS_DIR, exist_ok=True)
        with open(model_path, 'w', encoding='utf-8') as f:
            json.dump(model_doc, f, indent=4, ensure_ascii=False)
        with open(layout_path, 'w', encoding='utf-8') as f:
            json.dump(layout_doc, f, indent=4, ensure_ascii=False)
        logger.info('Created working model %s and layout %s', model_path, layout_path)
    except OSError as e:
        logger.error('create_model write failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500
    return jsonify({'success': True, 'stem': stem}), 200


def stem_from_open_model_json():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify({'success': False, 'error': 'expected JSON object'}), 400)
    stem, why = parse_model_stem(data.get('model'))
    if stem is None:
        msg = 'invalid model' if why == 'unsafe' else 'missing or invalid model'
        return None, (jsonify({'success': False, 'error': msg}), 400)
    if is_working_stem(stem):
        return None, (jsonify({'success': False, 'error': 'invalid model'}), 400)
    if stem not in list_model_stems():
        return None, (jsonify({'success': False, 'error': 'unknown model'}), 404)
    return stem, None


def stem_from_save_model_json():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify({'success': False, 'error': 'expected JSON object'}), 400)
    stem, why = parse_model_stem(data.get('model'))
    if stem is None:
        msg = 'invalid model' if why == 'unsafe' else 'missing or invalid model'
        return None, (jsonify({'success': False, 'error': msg}), 400)
    if is_working_stem(stem):
        return None, (jsonify({'success': False, 'error': 'invalid model'}), 400)
    wstem = working_stem(stem)
    if not os.path.isfile(model_json_path(wstem)):
        return None, (jsonify({
            'success': False,
            'error': 'no working copy; open or create the model first',
        }), 400)
    return stem, None


@app.route('/api/open_model', methods=['POST'])
def api_open_model():
    stem, err = stem_from_open_model_json()
    if err:
        return err
    try:
        src_model = model_json_path(stem)
        dst_model = model_json_path(working_stem(stem))
        os.makedirs(LAYOUTS_DIR, exist_ok=True)
        shutil.copy2(src_model, dst_model)
        src_layout = layout_json_path(stem)
        dst_layout = layout_json_path(working_stem(stem))
        if os.path.isfile(src_layout):
            shutil.copy2(src_layout, dst_layout)
        else:
            with open(dst_layout, 'w', encoding='utf-8') as f:
                json.dump({'layout': []}, f, indent=4, ensure_ascii=False)
        logger.info('Opened model %s into working copy %s', stem, working_stem(stem))
        return jsonify({'success': True, 'stem': stem}), 200
    except OSError as e:
        logger.error('open_model failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/save_model', methods=['POST'])
def api_save_model():
    stem, err = stem_from_save_model_json()
    if err:
        return err
    wstem = working_stem(stem)
    try:
        with open('schemas/model.json') as f:
            model_schema = json.load(f)
        with open('schemas/layout.json') as f:
            layout_schema = json.load(f)
        with open(model_json_path(wstem), encoding='utf-8') as f:
            model_doc = json.load(f)
        if 'meta' not in model_doc:
            model_doc['meta'] = {}
        model_doc['meta']['modified'] = utc_iso_timestamp()
        jsonschema.validate(instance=model_doc, schema=model_schema)
        layout_path_w = layout_json_path(wstem)
        if os.path.isfile(layout_path_w):
            with open(layout_path_w, encoding='utf-8') as f:
                layout_doc = json.load(f)
        else:
            layout_doc = {'layout': []}
        jsonschema.validate(instance=layout_doc, schema=layout_schema)
        os.makedirs(LAYOUTS_DIR, exist_ok=True)
        with open(model_json_path(stem), 'w', encoding='utf-8') as f:
            json.dump(model_doc, f, indent=4, ensure_ascii=False)
        with open(layout_json_path(stem), 'w', encoding='utf-8') as f:
            json.dump(layout_doc, f, indent=4, ensure_ascii=False)
        logger.info('Saved model %s from working copy %s', stem, wstem)
        return jsonify({'success': True, 'stem': stem}), 200
    except jsonschema.ValidationError as e:
        logger.error('save_model validation failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 400
    except OSError as e:
        logger.error('save_model write failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/list_models', methods=['GET'])
def api_list_models():
    return jsonify({'models': list_model_stems()})


@app.route('/api/load_model', methods=['POST'])
def api_load_model():
    stem, err = stem_from_post_json()
    if err:
        return err
    return load_model(stem)


def load_model(stem):
    with open('schemas/model.json') as f:
        schema = json.load(f)
        logger.info('Model schema loaded.')
    path = model_json_path(stem)
    with open(path) as f:
        data = json.load(f)
        logger.info('Model data loaded: %s', path)
    try:
        jsonschema.validate(instance=data, schema=schema)
        logger.info('Model schema validation success.')
    except jsonschema.ValidationError as e:
        logger.error('Model schema validation failed with ValidationError: %s', e)
    except Exception as e:
        logger.error('Model schema validation failed with exception: %s', e)
    return jsonify(data)


@app.route('/api/load_layout', methods=['POST'])
def api_load_layout():
    stem, err = stem_from_post_json()
    if err:
        return err
    return load_layout(stem)


def load_layout(stem):
    with open('schemas/layout.json') as f:
        schema = json.load(f)
        logger.info('Layout schema loaded.')
    path = layout_json_path(stem)
    if not os.path.isfile(path):
        logger.info('No layout file for %s, returning empty layout.', stem)
        return jsonify({'layout': []})
    with open(path) as f:
        data = json.load(f)
        logger.info('Layout loaded: %s', path)
    try:
        jsonschema.validate(instance=data, schema=schema)
        logger.info('Layout schema validation success.')
    except jsonschema.ValidationError as e:
        logger.error('Layout schema validation failed with ValidationError: %s', e)
    except Exception as e:
        logger.error('Layout schema validation failed with exception: %s', e)
    return jsonify(data)


@app.route('/api/save_layout', methods=['POST'])
def api_save_layout():
    stem, err = stem_from_save_layout_query()
    if err:
        return err
    layout_to_save = request.get_json()
    return save_layout(layout_to_save, stem)


def save_layout(layout_to_save, stem):
    with open('schemas/layout.json') as f:
        schema = json.load(f)
        logger.info('Layout schema loaded.')
    try:
        jsonschema.validate(instance=layout_to_save, schema=schema)
        logger.info('Layout schema validation success.')
        try:
            file_path = layout_json_path(stem)
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(layout_to_save, f, indent=4, ensure_ascii=False)
            return jsonify({
                'success': True,
                'message': f'Layout saved successfully to {file_path}'
            }), 200
        except Exception as e:
            logger.error('Layout save failed with exception: %s', e)
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500
    except jsonschema.ValidationError as e:
        logger.error('Layout schema validation failed with ValidationError: %s', e)
        return jsonify({
                'success': False,
                'error': str(e)
            }), 500
    except Exception as e:
        logger.error('Layout schema validation failed with exception: %s', e)
        return jsonify({
                'success': False,
                'error': str(e)
            }), 500

if __name__ == '__main__':
    app.run(debug=True, port=54321, host='localhost')
