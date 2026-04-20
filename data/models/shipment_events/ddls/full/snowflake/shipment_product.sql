CREATE TABLE shipment_product (
    shipment_product_uuid TEXT NOT NULL REFERENCES shipment (shipment_uuid),
    shipment_uuid TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_qty INTEGER NOT NULL,
    meta_source_event_names TEXT NOT NULL,
    meta_source_event_id_lst TEXT NOT NULL,
    meta_source_file_path_lst TEXT NOT NULL,
    meta_insert_timestamp TIMESTAMP_TZ NOT NULL,
    meta_updated_timestamp TIMESTAMP_TZ,
    PRIMARY KEY (shipment_product_uuid)
);
