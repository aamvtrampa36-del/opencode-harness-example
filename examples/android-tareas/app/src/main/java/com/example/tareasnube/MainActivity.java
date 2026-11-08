package com.example.tareasnube;

import android.app.Activity;
import android.os.Bundle;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String PREFS = "tareas_nube";
    private static final String SAVED = "saved_tasks";
    private static final int ACCENT = Color.rgb(36, 91, 198);
    private final TodoLogic todos = new TodoLogic();
    private LinearLayout taskRows;
    private EditText taskInput;
    private SharedPreferences preferences;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        restoreTasks();
        createInterface();
        renderTasks();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void createInterface() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(20), dp(16), dp(16));
        root.setBackgroundColor(Color.rgb(249, 250, 253));

        TextView heading = new TextView(this);
        heading.setText("Mis tareas");
        heading.setTextSize(28);
        heading.setTextColor(Color.rgb(28, 37, 58));
        heading.setPadding(0, 0, 0, dp(16));
        root.addView(heading);

        LinearLayout inputRow = new LinearLayout(this);
        inputRow.setOrientation(LinearLayout.HORIZONTAL);
        inputRow.setGravity(Gravity.CENTER_VERTICAL);

        taskInput = new EditText(this);
        taskInput.setSingleLine(true);
        taskInput.setHint("Escribe una tarea");
        taskInput.setTextSize(16);
        taskInput.setMaxLines(1);
        taskInput.setContentDescription("Nueva tarea");
        inputRow.addView(taskInput, new LinearLayout.LayoutParams(0, dp(52), 1));

        Button add = new Button(this);
        add.setText("Agregar");
        add.setAllCaps(false);
        add.setContentDescription("Agregar tarea");
        inputRow.addView(add, new LinearLayout.LayoutParams(dp(106), dp(52)));
        add.setOnClickListener(view -> addTask());
        root.addView(inputRow);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        taskRows = new LinearLayout(this);
        taskRows.setOrientation(LinearLayout.VERTICAL);
        taskRows.setPadding(0, dp(12), 0, 0);
        scroll.addView(taskRows);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        TextView footer = new TextView(this);
        footer.setText("Tus tareas se guardan en este teléfono. Funciona sin internet.");
        footer.setTextSize(12);
        footer.setTextColor(Color.DKGRAY);
        footer.setPadding(0, dp(8), 0, 0);
        root.addView(footer);
        setContentView(root);
    }

    private void addTask() {
        String name = taskInput.getText().toString();
        TodoLogic.Task created = todos.add(name);
        if (created == null) {
            Toast.makeText(this, "Escribe una tarea primero", Toast.LENGTH_SHORT).show();
            return;
        }
        taskInput.setText("");
        View focused = getCurrentFocus();
        if (focused != null) {
            InputMethodManager input = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (input != null) input.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
        saveTasks();
        renderTasks();
    }

    private void renderTasks() {
        taskRows.removeAllViews();
        if (todos.getTasks().isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText("Todavía no hay tareas. ¡Agrega una!");
            empty.setTextColor(Color.GRAY);
            empty.setTextSize(16);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, dp(48), 0, 0);
            taskRows.addView(empty);
            return;
        }
        for (TodoLogic.Task task : todos.getTasks()) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, dp(4), 0, dp(4));

            CheckBox check = new CheckBox(this);
            check.setText(task.title);
            check.setTextSize(16);
            check.setTextColor(task.completed ? Color.GRAY : Color.rgb(28, 37, 58));
            check.setChecked(task.completed);
            check.setContentDescription("Completar: " + task.title);
            check.setOnClickListener(view -> {
                todos.toggle(task.id);
                saveTasks();
                renderTasks();
            });
            row.addView(check, new LinearLayout.LayoutParams(0, dp(58), 1));

            Button remove = new Button(this);
            remove.setText("Eliminar");
            remove.setAllCaps(false);
            remove.setContentDescription("Eliminar: " + task.title);
            remove.setOnClickListener(view -> {
                todos.remove(task.id);
                saveTasks();
                renderTasks();
            });
            row.addView(remove, new LinearLayout.LayoutParams(dp(106), dp(52)));
            taskRows.addView(row);
        }
    }

    private void saveTasks() {
        JSONArray arr = new JSONArray();
        for (TodoLogic.Task t : todos.getTasks()) {
            JSONObject obj = new JSONObject();
            try {
                obj.put("id", t.id);
                obj.put("title", t.title);
                obj.put("done", t.completed);
                arr.put(obj);
            } catch (Exception ignored) {
                // A task can always be recreated if a local JSON write fails.
            }
        }
        preferences.edit().putString(SAVED, arr.toString()).apply();
    }

    private void restoreTasks() {
        try {
            JSONArray arr = new JSONArray(preferences.getString(SAVED, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null) continue;
                try {
                    todos.restore(new TodoLogic.Task(
                        obj.getString("id"), obj.getString("title"),
                        obj.optBoolean("done", false)
                    ));
                } catch (Exception ignored) {
                    // Ignore a malformed single task rather than crashing the app.
                }
            }
        } catch (Exception ignored) {
            // Corrupt local storage should never prevent opening the app.
        }
    }
}
