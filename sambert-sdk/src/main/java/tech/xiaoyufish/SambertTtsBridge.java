package tech.xiaoyufish;

import com.alibaba.dashscope.audio.tts.SpeechSynthesisAudioFormat;
import com.alibaba.dashscope.audio.tts.SpeechSynthesisParam;
import com.alibaba.dashscope.audio.tts.SpeechSynthesizer;
import com.alibaba.dashscope.utils.Constants;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * A stdin/stdout bridge around Alibaba's official Java DashScope SDK.
 * Stdout is intentionally reserved for binary audio; all diagnostics use stderr.
 */
public final class SambertTtsBridge {
  private SambertTtsBridge() {}

  public static void main(String[] args) {
    try {
      JsonObject request = JsonParser.parseReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).getAsJsonObject();
      String apiKey = environment("DASHSCOPE_SAMBERT_API_KEY", "DASHSCOPE_API_KEY", "BAILIAN_API_KEY");
      String websocketUrl = environment("DASHSCOPE_SAMBERT_WS_URL");
      if (apiKey.isBlank()) throw new IllegalArgumentException("Sambert API Key is empty");
      if (websocketUrl.isBlank()) throw new IllegalArgumentException("Sambert Workspace WebSocket URL is empty");

      // This is the same official SDK configuration shown in the Sambert docs.
      Constants.baseWebsocketApiUrl = websocketUrl;
      SpeechSynthesisParam param = SpeechSynthesisParam.builder()
          .apiKey(apiKey)
          .model(required(request, "model"))
          .text(required(request, "text"))
          .format(format(request))
          .sampleRate(number(request, "sampleRate", 16000))
          .volume(number(request, "volume", 50))
          .rate(decimal(request, "rate", 1.0f))
          .pitch(decimal(request, "pitch", 1.0f))
          .enableWordTimestamp(flag(request, "enableWordTimestamp"))
          .enablePhonemeTimestamp(flag(request, "enablePhonemeTimestamp"))
          .build();

      SpeechSynthesizer synthesizer = new SpeechSynthesizer();
      ByteBuffer audio = synthesizer.call(param);
      if (audio == null || !audio.hasRemaining()) throw new IllegalStateException("DashScope SDK returned no audio data; requestId=" + synthesizer.getLastRequestId());
      byte[] output = new byte[audio.remaining()];
      audio.get(output);
      System.out.write(output);
      System.out.flush();
    } catch (Exception error) {
      System.err.println("SAMBERT SDK ERROR: " + error.getMessage());
      error.printStackTrace(System.err);
      System.exit(1);
    }
  }

  private static String environment(String... names) {
    for (String name : names) {
      String value = System.getenv(name);
      if (value != null && !value.isBlank()) return value.trim();
    }
    return "";
  }

  private static String required(JsonObject object, String key) {
    String value = object.has(key) ? object.get(key).getAsString().trim() : "";
    if (value.isBlank()) throw new IllegalArgumentException(key + " is required");
    return value;
  }

  private static int number(JsonObject object, String key, int fallback) {
    return object.has(key) ? object.get(key).getAsInt() : fallback;
  }

  private static float decimal(JsonObject object, String key, float fallback) {
    return object.has(key) ? object.get(key).getAsFloat() : fallback;
  }

  private static boolean flag(JsonObject object, String key) {
    return object.has(key) && object.get(key).getAsBoolean();
  }

  private static SpeechSynthesisAudioFormat format(JsonObject object) {
    String value = object.has("format") ? object.get("format").getAsString() : "wav";
    return switch (value.trim().toLowerCase()) {
      case "pcm" -> SpeechSynthesisAudioFormat.PCM;
      case "mp3" -> SpeechSynthesisAudioFormat.MP3;
      default -> SpeechSynthesisAudioFormat.WAV;
    };
  }
}
