from flask import Flask, render_template, request, jsonify
from app_logger import get_logger
import json
import jsonschema
import os


# init logging
logger = get_logger(__name__)

# init app
app = Flask(__name__)

MODELS_DIR = os.path.join('data', 'models')
LAYOUTS_DIR = os.path.join(MODELS_DIR, 'layouts')


def list_model_stems():
    stems = []
    if not os.path.isdir(MODELS_DIR):
        return stems
    for name in os.listdir(MODELS_DIR):
        path = os.path.join(MODELS_DIR, name)
        if os.path.isfile(path) and name.lower().endswith('.json'):
            stems.append(os.path.splitext(name)[0])
    return sorted(stems)


def stem_from_post_json():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify({'error': 'expected JSON object'}), 400)
    stem = data.get('model')
    if not isinstance(stem, str) or not stem.strip():
        return None, (jsonify({'error': 'missing or invalid model'}), 400)
    stem = stem.strip()
    if '/' in stem or '\\' in stem or stem in ('.', '..') or os.path.basename(stem) != stem:
        return None, (jsonify({'error': 'invalid model'}), 400)
    if stem not in list_model_stems():
        return None, (jsonify({'error': 'unknown model'}), 404)
    return stem, None


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
    path = os.path.join(MODELS_DIR, f'{stem}.json')
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
    path = os.path.join(LAYOUTS_DIR, f'{stem}.json')
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
    stem = request.args.get('model', type=str)
    if stem is None or not stem.strip():
        return jsonify({'success': False, 'error': 'missing model query parameter'}), 400
    stem = stem.strip()
    if '/' in stem or '\\' in stem or stem in ('.', '..') or os.path.basename(stem) != stem:
        return jsonify({'success': False, 'error': 'invalid model'}), 400
    if stem not in list_model_stems():
        return jsonify({'success': False, 'error': 'unknown model'}), 400
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
            os.makedirs(LAYOUTS_DIR, exist_ok=True)
            file_path = os.path.join(LAYOUTS_DIR, f'{stem}.json')
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
