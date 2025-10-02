# MongoDB Resource Usage Results

## 🔥 CPU (%) – REPLICAS

| **Scenario**       | **REPLICA_localhost_27017** | **REPLICA_localhost_27018** | **REPLICA_localhost_27019** |
|---------------------|-----------------------------|-----------------------------|-----------------------------|
| **Oplog**          | 30.37                       | 30.37                       | **51.44** |
| **Events**         | 20.42                       | 20.58                       | 38.09 |
| **Pooling**        | 19.02                       | 19.10                       | 31.39 |
| **Change Streams** | 15.00                       | 15.28                       | 31.15 |

---

## 💾 Memory (MB) – REPLICAS

| **Scenario**       | **REPLICA_localhost_27017** | **REPLICA_localhost_27018** | **REPLICA_localhost_27019** |
|---------------------|-----------------------------|-----------------------------|-----------------------------|
| **Pooling**        | 384                         | 386                         | 399 |
| **Change Streams** | 370                         | 374                         | 386 |
| **Events**         | 378                         | 387                         | **402** |
| **Oplog**          | 355                         | 355                         | 340 |
---

## 🔥 CPU (%) – APP

| **Scenario**       | **APP** |
|---------------------|---------|
| **Oplog**          | **54.58** |
| **Events**         | 43.07 |
| **Change Streams** | 42.85 |
| **Pooling**        | 36.52 |

---

## 💾 Memory (MB) – APP

| **Scenario**       | **APP** |
|---------------------|---------|
| **Change Streams** | **422** |
| **Oplog**          | 360 |
| **Events**         | 379 |
| **Pooling**        | 355 |
