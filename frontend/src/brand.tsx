import {
  siAdminer, siAlmalinux, siAlpinelinux, siApache, siApachecassandra, siApachecouchdb, siApachekafka, siApachesolr,
  siApachetomcat, siArchlinux, siBun, siCaddy, siCentos, siClickhouse, siCockroachlabs, siConsul, siDebian, siDeno,
  siDocker, siDotnet, siEclipseadoptium, siEclipsemosquitto, siElasticsearch, siEnvoyproxy, siEtcd, siFedora, siGhost,
  siGitea, siGitlab, siGo, siGrafana, siHaproxy, siInfluxdb, siJenkins, siJupyter, siK3s, siKeycloak, siKibana,
  siKubernetes, siLogstash, siMariadb, siMattermost, siMinio, siMongodb, siMysql, siN8n, siNeo4j, siNextcloud, siNginx,
  siNodedotjs, siNodered, siOllama, siOpenjdk, siOpensearch, siPhp, siPhpmyadmin, siPortainer, siPostgresql,
  siPrometheus, siPython, siRabbitmq, siRancher, siRedis, siRockylinux, siRuby, siRust, siSelenium, siSpring,
  siTraefikproxy, siUbuntu, siVault, siWordpress,
  type SimpleIcon,
} from "simple-icons";
import { Icon } from "./ui";

// Words in an image's name → the product's mark. A name is matched whole
// first ("node-red"), then word by word ("nexcore-jdk" → jdk).
const marks: Record<string, SimpleIcon> = {
  ubuntu: siUbuntu, alpine: siAlpinelinux, debian: siDebian, fedora: siFedora, centos: siCentos,
  rockylinux: siRockylinux, rocky: siRockylinux, almalinux: siAlmalinux, archlinux: siArchlinux,
  nginx: siNginx, httpd: siApache, apache: siApache, tomcat: siApachetomcat, caddy: siCaddy,
  traefik: siTraefikproxy, haproxy: siHaproxy, envoy: siEnvoyproxy,
  postgres: siPostgresql, postgresql: siPostgresql, postgis: siPostgresql, pgvector: siPostgresql,
  mysql: siMysql, mariadb: siMariadb, redis: siRedis, mongo: siMongodb, mongodb: siMongodb,
  cassandra: siApachecassandra, couchdb: siApachecouchdb, clickhouse: siClickhouse, cockroach: siCockroachlabs,
  influxdb: siInfluxdb, neo4j: siNeo4j, etcd: siEtcd, minio: siMinio,
  elasticsearch: siElasticsearch, opensearch: siOpensearch, kibana: siKibana, logstash: siLogstash, solr: siApachesolr,
  kafka: siApachekafka, rabbitmq: siRabbitmq, mosquitto: siEclipsemosquitto,
  node: siNodedotjs, nodejs: siNodedotjs, bun: siBun, deno: siDeno, python: siPython, php: siPhp, ruby: siRuby,
  golang: siGo, rust: siRust, dotnet: siDotnet, aspnet: siDotnet,
  openjdk: siOpenjdk, jdk: siOpenjdk, jre: siOpenjdk, java: siOpenjdk, temurin: siEclipseadoptium, spring: siSpring,
  docker: siDocker, moby: siDocker, buildkit: siDocker, registry: siDocker, dind: siDocker,
  kubernetes: siKubernetes, kube: siKubernetes, k3s: siK3s, rancher: siRancher, portainer: siPortainer,
  grafana: siGrafana, prometheus: siPrometheus, vault: siVault, consul: siConsul, keycloak: siKeycloak,
  jenkins: siJenkins, gitlab: siGitlab, gitea: siGitea, selenium: siSelenium,
  wordpress: siWordpress, ghost: siGhost, nextcloud: siNextcloud, mattermost: siMattermost,
  adminer: siAdminer, phpmyadmin: siPhpmyadmin, jupyter: siJupyter, ollama: siOllama, n8n: siN8n,
  "node-red": siNodered,
};

/** "ghcr.io/owner/app:1.0" → { repo: "ghcr.io/owner/app", tag: "1.0" } */
export function splitRef(ref: string) {
  const at = ref.indexOf("@");
  const name = at < 0 ? ref : ref.slice(0, at);
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) return { repo: name.slice(0, colon), tag: name.slice(colon + 1) };
  return { repo: name, tag: at < 0 ? "latest" : "" };
}

function mark(image: string) {
  const path = splitRef(image).repo.toLowerCase().split("/");
  // The image's own name first, then who publishes it ("moby/buildkit").
  for (const part of path.reverse()) {
    if (marks[part]) return marks[part];
    for (const word of part.split(/[-_.]/)) if (marks[word]) return marks[word];
  }
  return null;
}

/** A product's own colour, unless it is too close to black or white to show on both themes. */
function tint(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return light < 0.2 || light > 0.85 ? null : `#${hex}`;
}

/** The square picture beside a container or image: the product's mark when the name says what it is. */
export function Avatar({ image, kind }: { image: string; kind: "box" | "layers" }) {
  const m = mark(image);
  if (!m) {
    return (
      <span className="avatar">
        <Icon name={kind} />
      </span>
    );
  }
  const color = tint(m.hex);
  return (
    <span className="avatar" title={m.title} style={color ? { color, background: `${color}22`, borderColor: `${color}44` } : undefined}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={m.path} />
      </svg>
    </span>
  );
}
