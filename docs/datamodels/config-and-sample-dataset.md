# Data model: configuration tabs and a sample dataset

The three configuration tabs (`Datasets`, `Variants`, `Assignments`) and one  
sample dataset on the source tab `Companies`. The sample rows follow the test  
fixtures in `Tests_Config.gs` (`sampleConfigValues_`, `sampleSourceValues_`).  

Mermaid attribute names cannot contain spaces, so source headers are written  
with underscores (`Company_Name` is the header `Company Name`).  

```mermaid
erDiagram
    DATASETS {
        string dataset_id PK "unique identifier, non-empty"
        string tab_name "source tab, e.g. Companies"
        string key_column "single column in the source tab, e.g. Company ID"
        string dataset_title "dataset title; optional column of one dataset per tab; required if several datasets per tab; unique within the tab; e.g. Canadian companies"
        string default_assignment FK "optional column; must belong to this dataset; empty = not runnable from the menu"
    }

    VARIANTS {
        string variant_id PK "unique identifier, non-empty; also the schema name sent to the API"
        string model "LLM model, required, e.g. openai/gpt-5.4-mini"
        string prompt_template "prompt template, may include {{placeholders}}, required"
        string instructions_template "instructions template, may include {{placeholders}}, optional"
        string tools "list of tools available to model, comma-separated, e.g. web_search, fetch_url"
        int max_urls "max number of urls to fetch; 1-10; needs fetch_url"
        int max_steps "max number of steps; >= 1"
        int max_output_tokens "max number of output tokens; optional column; required for anthropic/* models"
        json output_json_schema "schema of the model response, sent to the API as response_format; optional; root type must be object"
    }

    ASSIGNMENTS {
        string assignment_id PK "unique identifier, non-empty"
        string dataset_id FK "-> DATASETS"
        string variant_id FK "-> VARIANTS"
        json input_mapping "placeholder -> source column"
        json results_mapping "Results column -> envelope path; empty = no Results row"
        json writeback_mapping "optional column; source column -> envelope path"
    }

    SAMPLE_DATASET_CA_COMPANIES {
        string Company_ID PK "key_column; unique within the block"
        string Company_Name "company, acts as an input to assignment"
        string Country "country, acts as an input to assignment"
        string Title "empty on data rows; optional before a single dataset on a tab; required before each of the several datasets on a tab; e.g. Canadian companies"
        string HQ_City "headquarters location, acts as a write-back output for assignment, created if absent"
    }

    DATASETS ||--o{ ASSIGNMENTS : "dataset_id"
    VARIANTS ||--o{ ASSIGNMENTS : "variant_id"
    DATASETS |o--o| ASSIGNMENTS : "default_assignment"
    DATASETS ||--o{ SAMPLE_DATASET_CA_COMPANIES : "tab + dataset title define the block"
    ASSIGNMENTS ||..o{ SAMPLE_DATASET_CA_COMPANIES : "reads inputs, writes back outputs"
```

### Tables

- **DATASETS** (`Datasets` tab): one row per dataset. Says which source tab
  holds the dataset, which column is its row key, which block of rows it is  
  (by title, when a tab holds several datasets), and which assignment the  
  menu runs for its rows.  
- **VARIANTS** (`Variants` tab): one row per model configuration: model,
  prompt and instructions templates, tools and limits, and an optional JSON  
  schema for the answer. Several variants can run against the same dataset  
  for comparison.  
- **ASSIGNMENTS** (`Assignments` tab): one row per pairing of a dataset with
  a variant. Its mappings say which source columns fill the template  
  placeholders, which response values go to the `Results` tab, and which  
  are written back to the source tab.  
- **SAMPLE_DATASET_CA_COMPANIES** (`Companies` tab): an example source
  dataset, a block of Canadian companies keyed by `Company ID`. Its rows are  
  what the user selects and processes; `HQ City` is filled in by write-back.  

Solid lines are references stored in config cells. The dotted line is  
column-level use: an assignment reads its `input_mapping` columns from every  
row it processes and writes its `writeback_mapping` columns back by key.  

## Sample configuration rows

### Datasets

| dataset_id | tab_name | key_column | dataset_title | default_assignment |
|---|---|---|---|---|
| ca_companies | Companies | Company ID | Canadian companies | ca_hq_v1 |

The dataset is alone on its tab, so the title is optional; with an empty  
title the first block below the header row is used.  

### Variants

| variant_id | model | prompt_template | instructions_template | tools | max_urls | max_steps | max_output_tokens | output_json_schema |
|---|---|---|---|---|---|---|---|---|
| hq_v1 | openai/gpt-5.4-mini | `Find the HQ of {{company}} in {{ country }}.` | `Answer for {{company}} as JSON.` | web_search, fetch_url | 2 | 4 | 8192 | `{"type":"object","properties":{"headquarters_city":{"type":["string","null"]},"offices":{"type":"array","items":{"type":"object","properties":{"city":{"type":"string"}}}}}}` |

### Assignments

| assignment_id | dataset_id | variant_id | input_mapping | results_mapping | writeback_mapping |
|---|---|---|---|---|---|
| ca_hq_v1 | ca_companies | hq_v1 | `{"company": "Company Name", "country": "Country"}` | `{"First Office": "output_json.offices[0].city", "Cost": "usage.cost.total_cost"}` | `{"HQ City": "output_json.headquarters_city"}` |

`ca_hq_v1` writes the city back to the source tab and the first office and  
cost to `Results`.  

## Sample source tab: `Companies`

Headers are in row 1. The block is the run of keyed rows below the heading  
row; a row with an empty key ends it.  

| Sheet row | Company ID | Company Name | Country | Title | HQ City | Role |
|---|---|---|---|---|---|---|
| 1 | Company ID | Company Name | Country | Title | HQ City | header |
| 2 | | meta: used by another script | | | | skipped |
| 3 | | | | Canadian companies | | heading |
| 4 | 101 | Shopify | Canada | | | data |
| 5 | 102 | Wealthsimple | Canada | | | data |
| 6 | | | | | | ends the block |

`HQ City` is filled by `ca_hq_v1` when rows 4-5 are processed.  
