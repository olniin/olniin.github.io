/* Language selector */

const translations = {
  "en-US": {
    pageTitle: "ISC Scope",
    siteHeading: "ISC Scope",
    linkTutorial: "Tutorials",
    description: "Language test!"
  },
  "et": {
    pageTitle: "ISCi Ostsilloskoop",
    siteHeading: "ISCi Ostsilloskoop",
    linkTutorial: "Juhendid",
    description: "Keele test!"
  }
};

// arrow function to update page content based on language
const switchLanguage = (lang) => {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    element.textContent = translations[lang][key];
    // save prefered language
    localStorage.setItem("language", lang);
    // set html lang to selected language
    document.documentElement.lang = lang;
    // ensure the correct language is selected in the menu
    const selectMenu = document.getElementById("languageMenu");
    if (lang=="et") {
      selectMenu.selectedIndex = 0;
    } else {
      selectMenu.selectedIndex = 1;
    }
  });
}

// language menu interactibility
document.getElementById("languageMenu").addEventListener("change", (event) => {
  switchLanguage(event.target.value);
});

// set default language
if(!localStorage.getItem("language")) {
  switchLanguage("et");
} else {
  switchLanguage(localStorage.getItem("language"));
}
