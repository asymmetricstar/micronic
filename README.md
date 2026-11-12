
# MicroNic - Authoritative DNS & Interactive Console

An authoritative DNS server with interactive terminal console for zone management. Uses SQLite for storage and listens on the same port for UDP/TCP. The console supports domain creation, record management, and DNS resolution in one place.

## Features

- **Authoritative DNS**: Responds to queries for configured zones with cache-less authoritative answers
- **SQLite Storage**: Zones and records stored in SQLite (no native compilation required)
- **DNS Record Types**: A, AAAA, CNAME, NS, PTR, MX, TXT, SRV, NAPTR, CAA + custom `ENDPOINT`
- **CNAME Chains, Wildcards & Apex A**: Supports DNS chaining, wildcards, and apex A synthesis
- **NXDOMAIN/NODATA**: Correctly responds with no data for non-existent domains
- **Role-Based Access**: `admin`, `dns`, `none` roles with granular permissions
- **REST API**: Bearer token authentication, zone-scoped record operations
- **Interactive Console**: History, tab completion, password hiding, auto-suggest
- **Headless Mode**: Daemon mode for systemd, Docker, PM2, or headless servers
- **Configuration**: Environment variables for easy deployment

## Quick Start

```bash
npm i -g micronic
```

After installation, use the `micronic` command:

```bash
micronic
```

## Usage

### Interactive Shell

The shell provides:

```text
admin@micronic:~ $
```

| Part | Meaning |
|------|---------|
| `admin` | User name |
| `micronic` | Program name |
| `~` | Current domain (or `~` if none) |
| `$` | Command prompt |

**Navigation**: Arrows for command history, Tab for auto-suggestions
**Exit**: `exit`, `ctrl+d`, `:q`, `q`
**Help**: `help`, `help <command>`

### Domain Commands

```text
# Create a new domain
$ domain new example.test 127.0.0.1
# List all domains
$ domain list
# Use a domain for current session
$ domain use example.test
# Show domain details
$ domain show example.test
# Remove a domain
$ domain rm example.test --yes
```

### Record Commands

```text
# Add records (supports many types)
$ record add www A 127.0.0.1
$ record add mail MX "10 mail.example.test"
$ record add git ENDPOINT 127.0.0.1:3000
$ record add _sip._tcp SRV "0 5 5060 sip.example.test"

# List records
$ record list
$ record list www

# Remove records
$ record rm 1234 --yes
$ record rm mail MX --yes
```

### Lookup (DNS Query)

```text
# Basic lookup
$ lookup www.example.test A
# MX records
$ lookup example.test MX
# Endpoint lookup (custom type)
$ lookup git.local.host ENDPOINT
# With live server (requires running serve)
$ lookup www.example.test A --live
```

### Endpoint (Script-Friendly Output)

```bash
# Get endpoint for a service
ENDPOINT=$(micronic endpoint git.local.host)
echo "${ENDPOINT}"
# Output: "127.0.0.1:3000"
```

**Endpoint**: Commercial-grade DNS record type (RFC 65280) that embeds `host:port` information for services. Unlike traditional DNS, Endpoint enables zero-config service discovery for IoT, microservices, and containers by automatically resolving hostnames to production endpoints. Reduces infrastructure overhead by eliminating manual configuration and deployment pipelines for service-to-service communication.

**Business Value**: 
- **IoT Device Management**: Auto-resolve device IPs to gateways without manual table updates
- **Microservices**: Direct service-to-service communication at DNS level (no Nginx/Proxy required)
- **Kubernetes**: Resolve container service names to cluster IPs at deployment time
- **DevOps**: CI/CD pipelines automatically obtain production endpoints from DNS
- **Security**: Production-ready endpoints with proper TLS configuration
- **Cost Savings**: Eliminates 100+ line of config for service discovery in Kubernetes, Docker, and cloud environments.

### Server Management

```text
# Start/Stop server
$ serve start
$ serve stop
$ serve restart
$ serve status

# Daemon mode (headless)
$ npm run --silent daemon
# Output: "Server Running 127.0.0.1:5354"
```

### User Management

```text
# Create admin
$ register
# List users
$ user list
# Add user
$ user add leo dns
# Change role
$ user role leo admin
# Remove user
$ user rm leo --yes
```

## Command Format

```text
micronic <command> [<arguments>] [--flags]
```

Example:
```text
micronic domain new internal.test 10.0.0.10
micronic record add api A 192.0.2.10 --ttl 60
micronic lookup www.example.test A --live
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MICRONIC_DB` | `data/dns.db` | SQLite database path |
| `MICRONIC_HOST` | `127.0.0.1` | Server bind address |
| `MICRONIC_PORT` | `5354` | DNS port |
| `MICRONIC_API_PORT` | `8080` | HTTP API port |
| `MICRONIC_TTL` | `300` | Default TTL in seconds |
| `MICRONIC_ADMIN_PASSWORD` | `secret` | Default admin password |
| `MICRONIC_SEED_ZONE` | None | Initial test zone |
| `MICRONIC_SEED_IP` | `127.0.0.1` | Initial test IP |

## API

REST API for programmatic access:

- **Base URL**: `http://localhost:{MICRONIC_API_PORT}/api/v1/`
- **Auth**: Bearer token from `micronic login`
- **Operations**:
  - `GET /zones` - List zones
  - `POST /zones` - Create zone (admin only)
  - `DELETE /zones/{id}` - Delete zone (admin only)
  - `PUT /zones/{id}/records` - Add/replace records (admin only)
  - `DELETE /zones/{id}/records/{rrset}` - Delete record (admin only)
  - `GET /zones/{id}/records` - List records (dns/none)
  - `GET /zones/{id}/resolve` - Perform lookup (dns/none)



### Docker
```bash
docker build -t micronic .
docker run -p 5354:5354 -p 8080:8080 micronic
```

### Systemd
Create a service file:
```ini
[Unit]
Description=MicroNic DNS Server
After=network.target

[Service]
WorkingDirectory=/path/to/project
dbus-session-bus-name=micronic
Environment="MICRONIC_DB=/var/lib/micronic/dns.db"
ExecStart=node dist/index.js --daemon --port 5354 --api-port 8080
Restart=on-failure
StandardOutput=syslog
StandardError=syslog

[Install]
WantedBy=multi-user.target
```

## Security

- **Authentication**: Bearer token for REST API (stores session in memory)
- **Authorization**: Role-based access control (RBAC)
- **Input Validation**: Strict type checking for DNS inputs
- **SQL Injection**: Using parameterized queries with SQLite
- **XSS Protection**: No user input in DOM elements

## License

MIT License - See LICENSE file for details