# Pasos para limpiar lo publicado con la cuenta de la empresa

## 1. Unpublish las versiones de npm

Desde la terminal (la cuenta `dev6onelink` es la que publicó):

```bash
npm unpublish ngx-piano@0.0.1 --force
npm unpublish ngx-piano@0.0.2 --force
```

Si alguna ya fue instalada por otro y da error de "dependientes", el flujo alternativo es `npm deprecate`:

```bash
npm deprecate ngx-piano "Package moved to a new location" --all
```

(Y bumpeás `0.0.3` con la misma versión deprecada hasta que nadie la use.)

## 2. Mover el repo a tu cuenta personal

```bash
cd ~/Angular/a/puente/ngx-piano

# Crear repo nuevo en tu cuenta personal vía web:
#   https://github.com/new → "ngx-piano" (privado o público, lo que decidas)

# Cambiar el remote al nuevo repo
git remote set-url origin https://github.com/TU_USUARIO_PERSONAL/ngx-piano.git

# Verificar
git remote -v

# Push de todo (incluyendo los tags)
git push origin main --tags
```

## 3. Actualizar la metadata en projects/ngx-piano/package.json

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/TU_USUARIO_PERSONAL/ngx-piano.git"
  },
  "bugs": {
    "url": "https://github.com/TU_USUARIO_PERSONAL/ngx-piano/issues"
  },
  "homepage": "https://github.com/TU_USUARIO_PERSONAL/ngx-piano#readme"
}
```

## 4. Actualizar admin-operaciones (consumidor)

En `ngx-admin-operaciones/package.json`, antes de bumpear la versión, asegurate
de que el nombre en npm no choque. Si vas a re-publicar como `ngx-piano` con
tu cuenta personal, después de hacer el `npm publish` la versión anterior
va a quedar con tu nombre de autor nuevo (npm mantiene el historial).

## 5. Limpieza

```bash
# Borrar el tarball local
rm /tmp/ngx-piano-*.tgz

# Limpiar el ~/.npmrc con el token viejo (ya quedó expuesto en chat)
# 1. Generá un token NUEVO en https://www.npmjs.com/settings/dev6onelink/tokens
#    (o en tu nueva cuenta personal)
# 2. Marcar "Bypass 2FA" si no querés OTP cada vez
# 3. Reemplazar el token en ~/.npmrc:
npm config set //registry.npmjs.org/:_authToken=NUEVO_TOKEN
```

## 6. Re-publicar desde tu nueva cuenta

```bash
cd ~/Angular/a/puente/ngx-piano
npm run build:lib

# Editar projects/ngx-piano/package.json:
#   - version: "0.1.0" (o lo que sea, no choca con las anteriores)
#   - name: "ngx-piano" (o "@tu-usuario/ngx-piano" si querés scope)
#   - author: tu nombre/email
#   - repository: nueva URL

# Compilar de nuevo para que dist/ngx-piano/package.json tenga la nueva versión
npm run build:lib

# Publicar
cd dist/ngx-piano
npm publish --access public
```

---

# Mientras tanto, en el consumidor (admin-operaciones)

Si antes del unpublish hiciste `npm install`, el lockfile tiene la versión
vieja apuntando a `https://registry.npmjs.org/ngx-piano/...`. Después del
unpublish + re-publish, conviene refrescar:

```bash
cd ~/Angular/a/puente/ngx-admin-operaciones
npm cache clean --force
rm -rf node_modules/ngx-piano package-lock.json
npm install
```

(Y bumpear la versión en `package.json` si corresponde.)