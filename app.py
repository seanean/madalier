from flask import Flask, render_template, request, jsonify
from app_logger import get_logger
import base64
import binascii
import csv
import json
import jsonschema
import os
import re
import shutil
from datetime import datetime, timezone


# meta.technical_name and on-disk canonical file stem (lower_snake_case).
# The UI should mirror this pattern for instant feedback; the server still validates once here because
# anything can call the API (not only the browser).
TECHNICAL_NAME_RE = re.compile(r'^[a-z][a-z0-9_]*$')


class ApiError(Exception):
    """Raise from helpers; Flask error handler turns this into JSON + status (no tuple plumbing)."""

    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


# init logging
logger = get_logger(__name__)

# init app
app = Flask(__name__)


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify({'error': e.message}), e.status_code


def parse_technical_name_value(raw, field='technical_name'):
    """Enforce TECHNICAL_NAME_RE on a string. Raises ApiError on failure."""
    if not isinstance(raw, str):
        raise ApiError(f'missing or invalid {field}')
    tn = raw.strip()
    if not tn:
        raise ApiError(f'missing or invalid {field}')
    if not TECHNICAL_NAME_RE.fullmatch(tn):
        raise ApiError(f'invalid {field}')
    return tn


def parse_technical_name_field(data):
    """Extract technical_name from a JSON object and enforce format. Raises ApiError on failure."""
    if not isinstance(data, dict):
        raise ApiError('expected JSON object')
    return parse_technical_name_value(data.get('technical_name'))


def path_stem_from_envelope(data, *, require_working=False):
    """
    Same JSON shape for load/save: technical_name + optional working (JSON boolean true => temp_<tn> file).
    If require_working, body must include "working": true (e.g. save_working_model).
    """
    tn = parse_technical_name_field(data)
    working = data.get('working') is True
    if require_working and not working:
        raise ApiError('working must be true')
    path_stem = working_stem(tn) if working else tn
    if not os.path.isfile(model_json_path(path_stem)):
        raise ApiError('unknown model', 404)
    return path_stem

MODELS_DIR = os.path.join('data', 'models')

MODEL_CSV_COLUMNS = (
    'entity_type',
    'entity_business_name',
    'entity_technical_name',
    'entity_definition',
    'attribute_business_name',
    'attribute_technical_name',
    'mandatory',
    'data_type',
    'precision',
    'scale',
    'attribute_definition',
    'source_mapping',
)

# Reject absurd uploads (decoded PNG bytes).
MAX_DIAGRAM_PNG_BYTES = 15 * 1024 * 1024
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'


def _iter_model_subdirs():
    """Yield (name, abspath) for direct subdirectories of MODELS_DIR."""
    if not os.path.isdir(MODELS_DIR):
        return
    for name in sorted(os.listdir(MODELS_DIR)):
        path = os.path.join(MODELS_DIR, name)
        if os.path.isdir(path):
            yield name, path


def _find_json_in_model_subdirs(filename):
    """Return absolute path to MODELS_DIR/<subdir>/<filename> if it exists, else None."""
    for _, subdir_path in _iter_model_subdirs():
        p = os.path.join(subdir_path, filename)
        if os.path.isfile(p):
            return p
    return None


def list_technical_names():
    """Canonical models: data/models/<technical_name>/<technical_name>.json (technical_name from folder name)."""
    names = []
    for name, path in _iter_model_subdirs():
        if not TECHNICAL_NAME_RE.fullmatch(name):
            continue
        canon = os.path.join(path, f'{name}.json')
        if os.path.isfile(canon):
            names.append(name)
    return sorted(names)


def working_stem(technical_name):
    """Working JSON file stem for a canonical meta.technical_name."""
    return f'temp_{technical_name}'


def model_subdir_for_stem(stem):
    """
    Directory for this path stem. Canonical stem => data/models/<stem>/.
    Working temp_* => directory that already contains <stem>.json, else data/models/<suffix>/ for temp_<suffix>.
    """
    if stem.startswith('temp_'):
        found = _find_json_in_model_subdirs(f'{stem}.json')
        if found:
            return os.path.dirname(found)
        return os.path.join(MODELS_DIR, stem[5:])
    return os.path.join(MODELS_DIR, stem)


def model_json_path(stem):
    return os.path.join(model_subdir_for_stem(stem), f'{stem}.json')


def layout_json_path(stem):
    return os.path.join(model_subdir_for_stem(stem), f'layout_{stem}.json')


def diagram_png_path(technical_name):
    return os.path.join(MODELS_DIR, technical_name, f'{technical_name}.png')


def model_csv_path(technical_name):
    return os.path.join(MODELS_DIR, technical_name, f'{technical_name}.csv')


def ensure_model_subdir_for_stem(stem):
    d = model_subdir_for_stem(stem)
    os.makedirs(d, exist_ok=True)
    return d


def _csv_optional_str(value):
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    return str(value)


def _csv_mandatory_cell(attr):
    if 'mandatory' not in attr:
        return ''
    v = attr['mandatory']
    if not isinstance(v, bool):
        return ''
    return 'true' if v else 'false'


def _csv_int_cell(attr, key):
    if key not in attr:
        return ''
    v = attr[key]
    if v is None:
        return ''
    if isinstance(v, bool):
        return ''
    if isinstance(v, int):
        return str(v)
    return str(v)


def _entity_csv_prefix(ent):
    return [
        _csv_optional_str(ent.get('entity_type')),
        _csv_optional_str(ent.get('business_name')),
        _csv_optional_str(ent.get('technical_name')),
        _csv_optional_str(ent.get('definition')),
    ]


def _attribute_csv_suffix(attr):
    return [
        _csv_optional_str(attr.get('business_name')),
        _csv_optional_str(attr.get('technical_name')),
        _csv_mandatory_cell(attr),
        _csv_optional_str(attr.get('data_type')),
        _csv_int_cell(attr, 'precision'),
        _csv_int_cell(attr, 'scale'),
        _csv_optional_str(attr.get('definition')),
        _csv_optional_str(attr.get('source_mapping')),
    ]


def model_doc_to_csv_rows(model_doc):
    """One row per attribute; entities with no attributes get one row with blank attribute columns."""
    rows = []
    for ent in model_doc.get('entities') or []:
        prefix = _entity_csv_prefix(ent)
        attrs = list(ent.get('attributes') or [])
        indexed = list(enumerate(attrs))
        indexed.sort(
            key=lambda i_a: (
                i_a[1].get('attribute_order')
                if isinstance(i_a[1].get('attribute_order'), int)
                else (10**9),
                i_a[0],
            )
        )
        ordered_attrs = [a for _, a in indexed]
        if not ordered_attrs:
            rows.append(prefix + [''] * (len(MODEL_CSV_COLUMNS) - 4))
        else:
            for attr in ordered_attrs:
                rows.append(prefix + _attribute_csv_suffix(attr))
    return rows


def path_stem_from_load_json():
    data = request.get_json(silent=True)
    return path_stem_from_envelope(data)


def _require_str(data, key, *, non_empty=True):
    """Create payload: key must be present; value must be a string. Strip whitespace; non_empty enforces not ''."""
    if key not in data:
        raise ApiError(f'{key} is required')
    v = data[key]
    if v is None:
        raise ApiError(f'{key} is required')
    if not isinstance(v, str):
        raise ApiError(f'invalid {key}')
    v = v.strip()
    if non_empty and not v:
        raise ApiError(f'{key} is required')
    return v


def technical_name_from_post_create():
    """POST create: technical_name only; must not already exist on disk."""
    data = request.get_json(silent=True)
    tn = parse_technical_name_field(data)
    if tn in list_technical_names():
        raise ApiError('a model with this technical_name already exists', 409)
    if os.path.isfile(model_json_path(working_stem(tn))):
        raise ApiError('a working file already exists for this technical_name', 409)
    return tn


def utc_iso_timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


@app.route('/api/create_model', methods=['POST'])
def api_create_model():
    technical_name = technical_name_from_post_create()
    data = request.get_json(silent=True)
    display_name = _require_str(data, 'name', non_empty=True)
    description = _require_str(data, 'description', non_empty=False)
    version = _require_str(data, 'version', non_empty=True)
    created_by = _require_str(data, 'created_by', non_empty=False)
    now = utc_iso_timestamp()
    model_doc = {
        'meta': {
            'name': display_name,
            'technical_name': technical_name,
            'description': description,
            'created': now,
            'modified': now,
            'version': version,
            'created_by': created_by,
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
        raise ApiError(str(e), 400)
    try:
        wstem = working_stem(technical_name)
        ensure_model_subdir_for_stem(wstem)
        model_path = model_json_path(wstem)
        layout_path = layout_json_path(wstem)
        with open(model_path, 'w', encoding='utf-8') as f:
            json.dump(model_doc, f, indent=4, ensure_ascii=False)
        with open(layout_path, 'w', encoding='utf-8') as f:
            json.dump(layout_doc, f, indent=4, ensure_ascii=False)
        logger.info('Created working model %s and layout %s', model_path, layout_path)
    except OSError as e:
        logger.error('create_model write failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500
    return jsonify({'success': True, 'technical_name': technical_name}), 200


def technical_name_from_open_json():
    data = request.get_json(silent=True)
    tn = parse_technical_name_field(data)
    if tn not in list_technical_names():
        raise ApiError('unknown model', 404)
    return tn


def _delete_canonical_model_files(stem):
    """Remove canonical model folder artifacts for stem (validated). Best-effort."""
    if not TECHNICAL_NAME_RE.fullmatch(stem):
        return
    subdir = os.path.join(MODELS_DIR, stem)
    for basename in (
        f'{stem}.json',
        f'layout_{stem}.json',
        f'{stem}.csv',
        f'{stem}.png',
    ):
        path = os.path.join(subdir, basename)
        try:
            if os.path.isfile(path):
                os.remove(path)
                logger.info('Removed superseded file %s', path)
        except OSError as e:
            logger.warning('Could not remove %s: %s', path, e)
    try:
        if os.path.isdir(subdir) and not os.listdir(subdir):
            os.rmdir(subdir)
            logger.info('Removed empty model directory %s', subdir)
    except OSError as e:
        logger.warning('Could not remove directory %s: %s', subdir, e)


@app.route('/api/rename_working_model', methods=['POST'])
def api_rename_working_model():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'success': False, 'error': 'expected JSON object'}), 400
    try:
        old = parse_technical_name_value(data.get('from_technical_name'), 'from_technical_name')
        new = parse_technical_name_value(data.get('to_technical_name'), 'to_technical_name')
    except ApiError as e:
        return jsonify({'success': False, 'error': e.message}), 400
    if old == new:
        return jsonify({'success': True, 'technical_name': new}), 200
    w_old = working_stem(old)
    w_new = working_stem(new)
    old_model = model_json_path(w_old)
    new_model = model_json_path(w_new)
    if not os.path.isfile(old_model):
        return jsonify({'success': False, 'error': 'working model not found'}), 404
    if os.path.isfile(new_model):
        return jsonify(
            {'success': False, 'error': 'a working file already exists for that technical_name'}
        ), 409
    if new in list_technical_names():
        return jsonify(
            {'success': False, 'error': 'a canonical model with this technical_name already exists'}
        ), 409
    old_canon = model_json_path(old)
    old_dir = os.path.join(MODELS_DIR, old)
    new_dir = os.path.join(MODELS_DIR, new)
    draft_only = not os.path.isfile(old_canon)
    old_layout_canon = layout_json_path(w_old)
    new_layout_canon = layout_json_path(w_new)

    try:
        if draft_only:
            if os.path.isdir(new_dir):
                return jsonify(
                    {'success': False, 'error': 'a model folder already exists for that technical_name'}
                ), 409
            os.rename(old_dir, new_dir)
            try:
                os.rename(
                    os.path.join(new_dir, f'{w_old}.json'),
                    os.path.join(new_dir, f'{w_new}.json'),
                )
            except OSError:
                os.rename(new_dir, old_dir)
                raise
        else:
            os.rename(old_model, new_model)

        try:
            if draft_only:
                lo_src = os.path.join(new_dir, f'layout_{w_old}.json')
                lo_dst = os.path.join(new_dir, f'layout_{w_new}.json')
                if os.path.isfile(lo_src):
                    os.rename(lo_src, lo_dst)
            else:
                if os.path.isfile(old_layout_canon):
                    os.rename(old_layout_canon, new_layout_canon)
        except OSError:
            if draft_only:
                try:
                    os.rename(
                        os.path.join(new_dir, f'{w_new}.json'),
                        os.path.join(new_dir, f'{w_old}.json'),
                    )
                    os.rename(new_dir, old_dir)
                except OSError as e2:
                    logger.error('rename_working_model rollback failed: %s', e2)
            else:
                try:
                    os.rename(new_model, old_model)
                except OSError as e2:
                    logger.error('rename_working_model rollback failed: %s', e2)
            raise
    except OSError as e:
        logger.error('rename_working_model failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500
    logger.info('Renamed working model %s -> %s', old_model, new_model)
    return jsonify({'success': True, 'technical_name': new}), 200


@app.route('/api/open_model', methods=['POST'])
def api_open_model():
    tn = technical_name_from_open_json()
    try:
        os.makedirs(os.path.join(MODELS_DIR, tn), exist_ok=True)
        src_model = model_json_path(tn)
        dst_model = model_json_path(working_stem(tn))
        ensure_model_subdir_for_stem(working_stem(tn))
        shutil.copy2(src_model, dst_model)
        src_layout = layout_json_path(tn)
        dst_layout = layout_json_path(working_stem(tn))
        if os.path.isfile(src_layout):
            shutil.copy2(src_layout, dst_layout)
        else:
            with open(dst_layout, 'w', encoding='utf-8') as f:
                json.dump({'layout': []}, f, indent=4, ensure_ascii=False)
        logger.info('Opened model %s into working copy %s', tn, working_stem(tn))
        return jsonify({'success': True, 'technical_name': tn}), 200
    except OSError as e:
        logger.error('open_model failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/save_model', methods=['POST'])
def api_save_model():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'success': False, 'error': 'expected JSON object'}), 400
    try:
        tn = parse_technical_name_field(data)
    except ApiError as e:
        return jsonify({'success': False, 'error': e.message}), 400
    wstem = working_stem(tn)
    if not os.path.isfile(model_json_path(wstem)):
        return jsonify({'success': False, 'error': 'no working copy; open or create the model first'}), 400
    supersede_stem = None
    raw_sup = data.get('supersede_technical_name')
    if raw_sup is not None and str(raw_sup).strip() != '':
        try:
            supersede_stem = parse_technical_name_value(raw_sup, 'supersede_technical_name')
        except ApiError as e:
            return jsonify({'success': False, 'error': e.message}), 400
        if supersede_stem == tn:
            supersede_stem = None
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
        old_subdir = os.path.normpath(model_subdir_for_stem(wstem))
        new_subdir = os.path.normpath(os.path.join(MODELS_DIR, tn))
        os.makedirs(new_subdir, exist_ok=True)
        with open(model_json_path(tn), 'w', encoding='utf-8') as f:
            json.dump(model_doc, f, indent=4, ensure_ascii=False)
        with open(layout_json_path(tn), 'w', encoding='utf-8') as f:
            json.dump(layout_doc, f, indent=4, ensure_ascii=False)
        if old_subdir != new_subdir:
            w_model = os.path.join(old_subdir, f'{wstem}.json')
            w_layout = os.path.join(old_subdir, f'layout_{wstem}.json')
            dst_w_model = os.path.join(new_subdir, f'{wstem}.json')
            dst_w_layout = os.path.join(new_subdir, f'layout_{wstem}.json')
            if os.path.isfile(w_model) and os.path.normpath(w_model) != os.path.normpath(dst_w_model):
                shutil.move(w_model, dst_w_model)
            if os.path.isfile(w_layout) and os.path.normpath(w_layout) != os.path.normpath(dst_w_layout):
                shutil.move(w_layout, dst_w_layout)
        logger.info('Saved model %s from working copy %s', tn, wstem)
        if supersede_stem:
            _delete_canonical_model_files(supersede_stem)
        return jsonify({'success': True, 'technical_name': tn}), 200
    except jsonschema.ValidationError as e:
        logger.error('save_model validation failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 400
    except OSError as e:
        logger.error('save_model write failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/list_technical_names', methods=['GET'])
def api_list_technical_names():
    return jsonify({'technical_names': list_technical_names()})


@app.route('/api/naming_config', methods=['GET'])
def api_naming_config():
    path = os.path.join('data', 'config', 'naming_config.json')
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except OSError as e:
        logger.error('naming_config read failed: %s', e)
        return jsonify({'error': 'could not load naming config'}), 500
    try:
        with open('schemas/naming.json', encoding='utf-8') as f:
            naming_schema = json.load(f)
        jsonschema.validate(instance=data, schema=naming_schema)
    except jsonschema.ValidationError as e:
        logger.error('naming_config validation failed: %s', e)
        return jsonify({'error': str(e)}), 500
    return jsonify(data)


@app.route('/api/load_model', methods=['POST'])
def api_load_model():
    path_stem = path_stem_from_load_json()
    return load_model(path_stem)


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
    path_stem = path_stem_from_load_json()
    return load_layout(path_stem)


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


@app.route('/api/save_working_model', methods=['POST'])
def api_save_working_model():
    data = request.get_json(silent=True)
    path_stem = path_stem_from_envelope(data, require_working=True)
    model_doc = data.get('model')
    if not isinstance(model_doc, dict):
        return jsonify({'success': False, 'error': 'missing or invalid model'}), 400
    if 'meta' not in model_doc:
        model_doc['meta'] = {}
    model_doc['meta']['modified'] = utc_iso_timestamp()
    try:
        with open('schemas/model.json') as f:
            model_schema = json.load(f)
        jsonschema.validate(instance=model_doc, schema=model_schema)
    except jsonschema.ValidationError as e:
        logger.error('save_working_model validation failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 400
    try:
        ensure_model_subdir_for_stem(path_stem)
        with open(model_json_path(path_stem), 'w', encoding='utf-8') as f:
            json.dump(model_doc, f, indent=4, ensure_ascii=False)
        logger.info('Saved working model %s', model_json_path(path_stem))
        return jsonify({'success': True}), 200
    except OSError as e:
        logger.error('save_working_model write failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/export_model_csv', methods=['POST'])
def api_export_model_csv():
    data = request.get_json(silent=True)
    path_stem = path_stem_from_envelope(data)
    path = model_json_path(path_stem)
    with open(path, encoding='utf-8') as f:
        model_doc = json.load(f)
    with open('schemas/model.json') as f:
        model_schema = json.load(f)
    try:
        jsonschema.validate(instance=model_doc, schema=model_schema)
    except jsonschema.ValidationError as e:
        logger.error('export_model_csv validation failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 400
    meta = model_doc.get('meta') or {}
    tn = meta.get('technical_name')
    if not isinstance(tn, str) or not tn.strip():
        return jsonify({'success': False, 'error': 'model meta.technical_name is missing'}), 400
    try:
        parse_technical_name_value(tn, field='meta.technical_name')
    except ApiError as e:
        return jsonify({'success': False, 'error': e.message}), 400
    os.makedirs(os.path.join(MODELS_DIR, tn), exist_ok=True)
    out_path = model_csv_path(tn)
    rel_path = f'data/models/{tn}/{tn}.csv'
    try:
        with open(out_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(MODEL_CSV_COLUMNS)
            for row in model_doc_to_csv_rows(model_doc):
                writer.writerow(row)
        logger.info('Exported model CSV %s', out_path)
    except OSError as e:
        logger.error('export_model_csv write failed: %s', e)
        return jsonify({'success': False, 'error': str(e)}), 500
    return jsonify({'success': True, 'path': rel_path}), 200


@app.route('/api/save_diagram_png', methods=['POST'])
def api_save_diagram_png():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError('expected JSON object')
    tn = parse_technical_name_field(data)
    raw_b64 = data.get('png_base64')
    if not isinstance(raw_b64, str) or not raw_b64.strip():
        raise ApiError('png_base64 is required')
    s = raw_b64.strip()
    if s.startswith('data:') and ',' in s:
        s = s.split(',', 1)[1]
    try:
        png_bytes = base64.b64decode(s, validate=True)
    except binascii.Error:
        raise ApiError('invalid base64')
    if len(png_bytes) > MAX_DIAGRAM_PNG_BYTES:
        raise ApiError('PNG too large')
    if not png_bytes.startswith(PNG_MAGIC):
        raise ApiError('not a PNG image')
    wstem = working_stem(tn)
    if not os.path.isfile(model_json_path(wstem)) and tn not in list_technical_names():
        raise ApiError('unknown model', 404)
    os.makedirs(os.path.join(MODELS_DIR, tn), exist_ok=True)
    out_path = diagram_png_path(tn)
    try:
        with open(out_path, 'wb') as f:
            f.write(png_bytes)
        logger.info('Saved diagram PNG %s', out_path)
    except OSError as e:
        logger.error('save_diagram_png write failed: %s', e)
        raise ApiError(str(e), 500)
    return jsonify({'success': True}), 200


@app.route('/api/save_layout', methods=['POST'])
def api_save_layout():
    data = request.get_json(silent=True)
    path_stem = path_stem_from_envelope(data)
    layout_arr = data.get('layout')
    if not isinstance(layout_arr, list):
        return jsonify({'success': False, 'error': 'missing or invalid layout array'}), 400
    layout_to_save = {'layout': layout_arr}
    return save_layout(layout_to_save, path_stem)


def save_layout(layout_to_save, stem):
    with open('schemas/layout.json') as f:
        schema = json.load(f)
        logger.info('Layout schema loaded.')
    try:
        jsonschema.validate(instance=layout_to_save, schema=schema)
        logger.info('Layout schema validation success.')
        try:
            ensure_model_subdir_for_stem(stem)
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
