package me.berrycraft.mirrorbot;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import net.skinsrestorer.api.SkinsRestorer;
import net.skinsrestorer.api.SkinsRestorerProvider;
import net.skinsrestorer.api.exception.DataRequestException;
import net.skinsrestorer.api.property.InputDataResult;
import net.skinsrestorer.api.property.SkinIdentifier;
import net.skinsrestorer.api.property.SkinProperty;
import net.skinsrestorer.api.storage.PlayerStorage;
import net.skinsrestorer.api.storage.SkinStorage;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.*;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public class SkinManager {

    private final EpisodeManager plugin;
    private final SkinsRestorer skinsRestorer;
    private final File skinsDir;

    public SkinManager(EpisodeManager plugin) {
        this.plugin = plugin;

        if (Bukkit.getPluginManager().getPlugin("SkinsRestorer") != null) {
            skinsRestorer = SkinsRestorerProvider.get();
            plugin.getLogger().info("[SkinManager] SkinsRestorer detected, API attached.");
        } else {
            plugin.getLogger().warning("[SkinManager] SkinsRestorer not found. Skins will not be applied.");
            skinsRestorer = null;
        }

        this.skinsDir = resolveSkinsDirectory();
        if (skinsDir != null) {
            boolean created = skinsDir.mkdirs();
            plugin.getLogger().info("[SkinManager] Skins directory resolved to: " + skinsDir.getAbsolutePath() + " (created=" + created + ")");
        } else {
            plugin.getLogger().warning("[SkinManager] Failed to resolve skins directory; custom skins will be unavailable.");
        }
    }

    // ------------------------------------------------------------------------------------
    // Skin Loading
    // ------------------------------------------------------------------------------------

    public Map<String, File> loadSkins() {
        if (skinsDir == null || !skinsDir.exists()) {
            plugin.getLogger().warning("[SkinManager] Skins directory missing: " + skinsDir);
            return Collections.emptyMap();
        }

        Map<String, File> map = new TreeMap<>();
        File[] list = skinsDir.listFiles((dir, name) -> name.endsWith(".png"));
        if (list == null) {
            plugin.getLogger().warning("[SkinManager] listFiles returned null for: " + skinsDir.getAbsolutePath());
            return map;
        }

        for (File f : list) {
            map.put(normalizeName(f.getName()), f);
        }

        plugin.getLogger().info("[SkinManager] Loaded " + map.size() + " skin(s) from " + skinsDir.getAbsolutePath());
        return map;
    }

    /**
     * Pre-populates SkinsRestorer's SkinStorage from .customskin cache files.
     * Each .png in the skins directory must have a corresponding .png.customskin file
     * containing pre-signed Mojang texture data.
     *
     * @param skins the map returned by {@link #loadSkins()}
     * @return true if all skins were pre-cached successfully, false if any are missing
     */
    public boolean preloadSkinCache(Map<String, File> skins) {
        if (skinsRestorer == null) {
            plugin.getLogger().warning("[SkinManager] SkinsRestorer unavailable; cannot preload skin cache.");
            return false;
        }

        SkinStorage storage = skinsRestorer.getSkinStorage();
        if (storage == null) {
            plugin.getLogger().severe("[SkinManager] SkinStorage is null; cannot preload skin cache.");
            return false;
        }

        boolean allOk = true;
        for (Map.Entry<String, File> entry : skins.entrySet()) {
            File pngFile = entry.getValue();
            File cacheFile = new File(pngFile.getAbsolutePath() + ".customskin");

            if (!cacheFile.exists()) {
                plugin.getLogger().severe("[SkinManager] Missing .customskin cache for " + pngFile.getName()
                        + ". Run regenerate_skin_cache.py on the host to create it.");
                allOk = false;
                continue;
            }

            try {
                String json = Files.readString(cacheFile.toPath());
                JsonObject obj = JsonParser.parseString(json).getAsJsonObject();
                String value = obj.get("value").getAsString();
                String signature = obj.get("signature").getAsString();

                String key = "file:" + pngFile.getName().toLowerCase(Locale.ROOT);
                SkinProperty property = SkinProperty.of(value, signature);
                storage.setCustomSkinData(key, property);

                plugin.getLogger().info("[SkinManager] Pre-cached skin: " + key + " from " + cacheFile.getName());
            } catch (IOException e) {
                plugin.getLogger().severe("[SkinManager] Failed to read cache file " + cacheFile.getName() + ": " + e.getMessage());
                allOk = false;
            } catch (Exception e) {
                plugin.getLogger().severe("[SkinManager] Failed to parse cache file " + cacheFile.getName() + ": " + e.getMessage());
                allOk = false;
            }
        }

        return allOk;
    }

    public File resolveSkin(String key, Map<String, File> skins) {
        return skins.get(normalizeName(key));
    }

    private String normalizeName(String name) {
        name = name.toLowerCase(Locale.ROOT);
        if (name.endsWith(".png")) name = name.substring(0, name.length() - 4);

        int underscore = name.indexOf('_');
        if (underscore > 0) {
            String prefix = name.substring(0, underscore);
            if (prefix.chars().allMatch(Character::isDigit)) {
                name = name.substring(underscore + 1);
            }
        }
        return name;
    }

    // ------------------------------------------------------------------------------------
    // Skin Application
    // ------------------------------------------------------------------------------------

    public void applySharedSkin(Player controller, Player camera, File file) {
        if (skinsRestorer == null) {
            plugin.getLogger().warning("[SkinManager] SkinsRestorer unavailable; skipping skin apply for " + controller.getName() + " / " + camera.getName());
            return;
        }

        plugin.getLogger().info("[SkinManager] Applying shared skin " + file.getName() + " to " + controller.getName() + " and " + camera.getName());

        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                SkinStorage storage = skinsRestorer.getSkinStorage();
                if (storage == null) {
                    plugin.getLogger().severe("[SkinManager] SkinStorage is null; cannot apply skin.");
                    return;
                }

                String key = "file:" + file.getName().toLowerCase(Locale.ROOT);

                Optional<InputDataResult> cached = storage.findSkinData(key);
                if (cached.isEmpty()) {
                    plugin.getLogger().severe("[SkinManager] No pre-cached skin data for key " + key
                            + ". Ensure .customskin files are present in the skins directory.");
                    return;
                }

                plugin.getLogger().info("[SkinManager] Using pre-cached skin for key " + key);
                SkinIdentifier id = cached.get().getIdentifier();

                PlayerStorage ps = skinsRestorer.getPlayerStorage();
                ps.setSkinIdOfPlayer(controller.getUniqueId(), id);
                ps.setSkinIdOfPlayer(camera.getUniqueId(), id);

                Bukkit.getScheduler().runTask(plugin, () -> {
                    try {
                        skinsRestorer.getSkinApplier(Player.class).applySkin(controller);
                        skinsRestorer.getSkinApplier(Player.class).applySkin(camera);
                    } catch (DataRequestException e) {
                        e.printStackTrace();
                    }
                });

            } catch (Exception ex) {
                plugin.getLogger().severe("[SkinManager] Failed to apply skin " + file.getName() + ": " + ex.getMessage());
                ex.printStackTrace();
            }
        });
    }

    private File resolveSkinsDirectory() {
        try {
            File pluginFolder = plugin.getDataFolder().getCanonicalFile();
            File pluginsDir = pluginFolder.getParentFile();

            File dataDir = pluginsDir.getParentFile();
            return (dataDir != null)
                    ? new File(dataDir, "skins")
                    : new File(pluginsDir, "skins");
        } catch (IOException e) {
            return null;
        }
    }
}
