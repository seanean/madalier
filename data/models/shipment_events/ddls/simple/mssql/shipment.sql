CREATE TABLE [shipment] (
    [shipment_uuid] NVARCHAR(MAX) NOT NULL,
    [shipment_business_id] NVARCHAR(MAX) NOT NULL,
    [shipment_technical_id] NVARCHAR(MAX) NOT NULL,
    [shipment_type] NVARCHAR(MAX) NOT NULL,
    [meta_source_event_names] NVARCHAR(MAX) NOT NULL,
    [meta_source_event_id_lst] NVARCHAR(MAX) NOT NULL,
    [meta_source_file_path_lst] NVARCHAR(MAX) NOT NULL,
    [meta_insert_timestamp] DATETIMEOFFSET NOT NULL,
    [meta_updated_timestamp] DATETIMEOFFSET
);
